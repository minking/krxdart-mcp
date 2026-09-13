#!/usr/bin/env node
/**
 * krxdart-mcp: Pure DART Disclosures & KRX Market Data MCP Server
 * Zero-transformation, 100% Raw Official API Proxy
 * Standards: Open DART API + Data.go.kr KRX Securities Price Info API
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import AdmZip from 'adm-zip';

const server = new McpServer({
  name: 'krxdart-mcp',
  version: '2.0.0'
});

// ============================================================================
// 1. 레이트 리미터 & 안전 실행 래퍼 (Rate Limiter & Safe Tool Wrapper)
// ============================================================================
function createRateLimiter(intervalMs: number) {
  let chain: Promise<any> = Promise.resolve();
  let lastRequestAt = 0;

  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const wait = intervalMs - (Date.now() - lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await task();
      } finally {
        lastRequestAt = Date.now();
      }
    });
    chain = next.catch(() => {});
    return next;
  };
}

// DART 공식 호출 규정 (초당 4회, 250ms 간격 직렬 큐)
const enqueueDart = createRateLimiter(250);
// 공공데이터포털 KRX 시세 호출 규정 (초당 10회, 100ms 간격 직렬 큐)
const enqueueKrx = createRateLimiter(100);

async function safeTool(action: () => Promise<unknown>) {
  try {
    const data = await action();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }]
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `오류 발생: ${message}` }]
    };
  }
}

// ============================================================================
// 2. 인증키 관리 (서버 환경변수에서만 획득)
// ============================================================================
function getDartApiKey(): string {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error('DART_API_KEY 환경변수가 설정되지 않았습니다. 금융감독원 오픈API 키를 등록해주세요.');
  return key;
}

function getKrxApiKey(): string {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error('KRX_API_KEY 환경변수가 설정되지 않았습니다. 공공데이터포털(한국거래소/금융위) API 키를 등록해주세요.');
  return key;
}

// ============================================================================
// 3. DART 원본 API 클라이언트 (/api/*)
// ============================================================================
const DART_BASE_URL = 'https://opendart.fss.or.kr/api';

async function fetchDart(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const key = getDartApiKey();
  return enqueueDart(async () => {
    const searchParams = new URLSearchParams({ crtfc_key: key });
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') {
        searchParams.set(k, String(v));
      }
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const res = await fetch(`${DART_BASE_URL}${cleanEndpoint}?${searchParams}`, {
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) throw new Error(`DART HTTP 오류: ${res.status} ${res.statusText}`);

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: '999', message: text.slice(0, 500) };
    }

    if (json?.status && json.status !== '000') {
      if (json.status === '020') throw new Error('[DART 한도 초과] 일일 호출 한도(10,000회)를 초과했습니다.');
      if (json.status === '010' || json.status === '011') throw new Error('[DART 키 오류] 유효하지 않은 DART_API_KEY입니다.');
    }
    return json;
  });
}

function decodeDartBuffer(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(buffer);
    } catch {
      return buffer.toString('utf-8');
    }
  }
}

async function fetchDartDocument(rceptNo: string): Promise<unknown> {
  const key = getDartApiKey();
  return enqueueDart(async () => {
    const url = `${DART_BASE_URL}/document.xml?crtfc_key=${key}&rcept_no=${rceptNo}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`DART 문서 다운로드 실패: ${res.status} ${res.statusText}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    try {
      const zip = new AdmZip(buffer);
      const files = zip.getEntries().map((entry) => ({
        name: entry.entryName,
        size: entry.header.size,
        content: decodeDartBuffer(entry.getData())
      }));
      return {
        rcept_no: rceptNo,
        direct_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`,
        files
      };
    } catch {
      return {
        rcept_no: rceptNo,
        direct_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`,
        content: decodeDartBuffer(buffer)
      };
    }
  });
}

// ============================================================================
// 4. KRX 공공데이터포털 공식 API 클라이언트 (GetStockSecuritiesInfoService)
// ============================================================================
const KRX_BASE_URL = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService';

async function fetchKrx(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const apiKey = getKrxApiKey();
  return enqueueKrx(async () => {
    const cleanKey = apiKey.includes('%') ? decodeURIComponent(apiKey) : apiKey;
    const searchParams = new URLSearchParams({
      serviceKey: cleanKey,
      resultType: 'json'
    });

    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') {
        searchParams.set(k, String(v));
      }
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const url = `${KRX_BASE_URL}/${cleanEndpoint}?${searchParams.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`KRX HTTP 오류: ${res.status} ${res.statusText}`);

    const json: any = await res.json().catch(() => null);
    if (!json) throw new Error('KRX 응답이 올바른 JSON 형식이 아닙니다.');

    const resultCode = json?.response?.header?.resultCode;
    if (resultCode && resultCode !== '00') {
      const resultMsg = json?.response?.header?.resultMsg || '공공데이터포털 오류';
      throw new Error(`[KRX API 오류] ${resultCode}: ${resultMsg}`);
    }

    return json;
  });
}

// ============================================================================
// 5. 기업 고유번호 인메모리 O(1) 인덱스 맵 (In-flight Promise 캐싱)
// ============================================================================
interface CorpItem {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  modify_date: string;
}

let corpCodeCache: CorpItem[] | null = null;
let corpCodeLoadPromise: Promise<CorpItem[]> | null = null;
const stockCodeIndex = new Map<string, CorpItem>();
const corpCodeIndex = new Map<string, CorpItem>();

const CACHE_FILE = path.join(os.tmpdir(), 'krxdart_corp_codes.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const REGEX_LIST = /<list>([\s\S]*?)<\/list>/g;
const REGEX_CORP_CODE = /<corp_code>([^<]*?)<\/corp_code>/;
const REGEX_CORP_NAME = /<corp_name>([^<]*?)<\/corp_name>/;
const REGEX_STOCK_CODE = /<stock_code>([^<]*?)<\/stock_code>/;
const REGEX_MODIFY_DATE = /<modify_date>([^<]*?)<\/modify_date>/;

function buildIndexes(items: CorpItem[]) {
  stockCodeIndex.clear();
  corpCodeIndex.clear();
  for (const it of items) {
    if (it.stock_code) stockCodeIndex.set(it.stock_code, it);
    if (it.corp_code) corpCodeIndex.set(it.corp_code, it);
  }
}

async function loadCorpCodeList(): Promise<CorpItem[]> {
  if (corpCodeCache) return corpCodeCache;
  if (corpCodeLoadPromise) return corpCodeLoadPromise;

  corpCodeLoadPromise = (async () => {
    // 1. 디스크 캐시 확인
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const stats = fs.statSync(CACHE_FILE);
        if (Date.now() - stats.mtimeMs < CACHE_TTL_MS) {
          const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
          const items: CorpItem[] = JSON.parse(raw);
          if (Array.isArray(items) && items.length > 0) {
            corpCodeCache = items;
            buildIndexes(items);
            return items;
          }
        }
      }
    } catch {
      // 캐시 파일 읽기 실패 시 무시하고 네트워크 다운로드 진행
    }

    // 2. DART 원본 다운로드
    const key = getDartApiKey();
    const buffer = await enqueueDart(async () => {
      const res = await fetch(`${DART_BASE_URL}/corpCode.xml?crtfc_key=${key}`, {
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`고유번호 파일 다운로드 실패: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });

    const zip = new AdmZip(buffer);
    const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.xml'));
    if (!xmlEntry) throw new Error('고유번호 ZIP 파일 내 XML 파일이 없습니다.');

    const xmlText = xmlEntry.getData().toString('utf-8');
    const items: CorpItem[] = [];

    REGEX_LIST.lastIndex = 0;
    let match;
    while ((match = REGEX_LIST.exec(xmlText)) !== null) {
      const b = match[1];
      items.push({
        corp_code: b.match(REGEX_CORP_CODE)?.[1]?.trim() || '',
        corp_name: b.match(REGEX_CORP_NAME)?.[1]?.trim() || '',
        stock_code: b.match(REGEX_STOCK_CODE)?.[1]?.trim() || '',
        modify_date: b.match(REGEX_MODIFY_DATE)?.[1]?.trim() || ''
      });
    }

    corpCodeCache = items;
    buildIndexes(items);

    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(items), 'utf-8');
    } catch {
      // 캐시 디스크 저장 실패는 무시
    }

    return items;
  })().finally(() => {
    corpCodeLoadPromise = null;
  });

  return corpCodeLoadPromise;
}

// ============================================================================
// 6. MCP 도구 등록 (단 4개의 순수 원본 도구)
// ============================================================================

// [1. DART 오픈API 원본 호출]
server.tool(
  'call_dart_api',
  '금융감독원 Open DART의 모든 공식 엔드포인트를 호출하여 원본 JSON을 그대로 반환합니다. DART 공식 문서(opendart.fss.or.kr)에 정의된 모든 엔드포인트(예: "/company.json", "/fnlttSinglAcnt.json", "/fnlttMultiAcnt.json", "/list.json", "/detSecIsu.json", "/piicDecsn.json" 등)와 파라미터를 그대로 사용할 수 있습니다. (DART_API_KEY는 서버에서 자동 주입)',
  {
    endpoint: z.string().regex(/^\/[a-zA-Z0-9_-]+\.json$/, '올바른 DART JSON 엔드포인트 경로여야 합니다 (예: "/company.json", "/list.json", "/fnlttSinglAcnt.json")'),
    params: z.record(z.any()).optional().default({}).describe('DART 요청 파라미터 객체 (예: corp_code, bsns_year, reprt_code, bgn_de 등)')
  },
  async ({ endpoint, params }) => safeTool(() => fetchDart(endpoint, params))
);

// [2. KRX 공공데이터포털 시세 API 원본 호출]
server.tool(
  'call_krx_api',
  '한국거래소(KRX)/금융위원회 공공데이터포털(apis.data.go.kr) 주식시세정보 공식 API를 호출하여 원본 JSON을 그대로 반환합니다. 단일 종목 시세, 시계열, 시장 전체 시세 등을 조회할 수 있습니다. (KRX_API_KEY는 서버에서 자동 주입)',
  {
    endpoint: z.enum(['getStockPriceInfo', 'getItemInfo']).default('getStockPriceInfo').describe('공공데이터포털 GetStockSecuritiesInfoService 엔드포인트 (기본: getStockPriceInfo)'),
    params: z.record(z.any()).describe('요청 파라미터 객체 (예: likeSrtnCd: "005930", basDt: "20240315", beginBasDt: "20240101", endBasDt: "20240315", numOfRows: 30 등)')
  },
  async ({ endpoint, params }) => safeTool(() => fetchKrx(endpoint, params))
);

// [3. DART 공시서류 원문 다운로드]
server.tool(
  'download_dart_document',
  'DART 공시 접수번호(rcept_no 14자리)의 법정 공시서류 원문 파일(ZIP/XML)을 내려받아 원문 파일 목록 및 디코딩된 본문 전체를 반환합니다. (/api/document.xml)',
  {
    rcept_no: z.string().regex(/^\d{14}$/, 'DART 접수번호는 14자리 숫자여야 합니다')
  },
  async ({ rcept_no }) => safeTool(() => fetchDartDocument(rcept_no))
);

// [4. 회사 고유번호 / 종목코드 O(1) 검색 유틸리티]
server.tool(
  'search_corp_code',
  '회사명, 6자리 종목코드, 또는 8자리 고유번호로 기업을 검색합니다. DART 고유번호(corp_code)와 거래소 종목코드(stock_code) 간의 브릿지 매핑을 O(1) 초고속으로 제공합니다.',
  {
    query: z.string().describe('회사명(예: "삼성전자"), 6자리 종목코드(예: "005930"), 또는 8자리 고유번호'),
    limit: z.number().int().min(1).max(50).default(10).describe('반환할 최대 결과 수 (기본: 10)')
  },
  async ({ query, limit }) =>
    safeTool(async () => {
      const list = await loadCorpCodeList();
      const q = query.trim().toLowerCase();

      // 1. 종목코드 6자리 O(1) 정확 일치
      if (/^\d{6}$/.test(q) && stockCodeIndex.has(q)) {
        return [stockCodeIndex.get(q)!];
      }
      // 2. DART 고유번호 8자리 O(1) 정확 일치
      if (/^\d{8}$/.test(q) && corpCodeIndex.has(q)) {
        return [corpCodeIndex.get(q)!];
      }

      // 3. 부분 일치 검색
      const isNum = /^\d+$/.test(q);
      const matched = list.filter((item) => {
        if (isNum) {
          if (item.stock_code.includes(q) || item.corp_code.includes(q)) return true;
        }
        return item.corp_name.toLowerCase().includes(q);
      });

      matched.sort((a, b) => {
        const aExact = a.corp_name.toLowerCase() === q;
        const bExact = b.corp_name.toLowerCase() === q;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        return 0;
      });

      return matched.slice(0, limit);
    })
);

// ============================================================================
// 7. 서버 실행
// ============================================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('krxdart-mcp 치명적 오류:', error);
  process.exit(1);
});

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ============================================================================
// 1. 요청 큐 (순차 실행으로 API 호출 간격 보장)
// ============================================================================
export function createQueue(minIntervalMs: number) {
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
      const wait = minIntervalMs - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = next.then(() => {}, () => {});
    return next;
  };
}

const krxQueue = createQueue(200);  // KRX: 초당 최대 5회 (200ms, 안전 마진 50%)
const dartQueue = createQueue(350); // DART: 초당 최대 약 2.8회 (350ms, IP 차단 방지 버퍼)

// ============================================================================
// 2. 한국거래소(KRX) 공식 31개 서비스 API
// ============================================================================
const KRX_BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis';

export const KRX_CATEGORY_MAP: Record<string, string> = {
  // 주식 (sto) - 8개
  stk_bydd_trd: 'sto', ksq_bydd_trd: 'sto', knx_bydd_trd: 'sto',
  sw_bydd_trd: 'sto', sr_bydd_trd: 'sto',
  stk_isu_base_info: 'sto', ksq_isu_base_info: 'sto', knx_isu_base_info: 'sto',
  // 증권상품 (etp) - 3개
  etf_bydd_trd: 'etp', etn_bydd_trd: 'etp', elw_bydd_trd: 'etp',
  // 지수 (idx) - 5개
  krx_dd_trd: 'idx', kospi_dd_trd: 'idx', kosdaq_dd_trd: 'idx', bon_dd_trd: 'idx', drvprod_dd_trd: 'idx',
  // 채권 (bon) - 3개
  kts_bydd_trd: 'bon', bnd_bydd_trd: 'bon', smb_bydd_trd: 'bon',
  // 파생상품 (drv) - 6개
  fut_bydd_trd: 'drv', eqsfu_stk_bydd_trd: 'drv', eqkfu_ksq_bydd_trd: 'drv',
  opt_bydd_trd: 'drv', eqsop_bydd_trd: 'drv', eqkop_bydd_trd: 'drv',
  // 일반상품 (gen) - 3개
  oil_bydd_trd: 'gen', gold_bydd_trd: 'gen', ets_bydd_trd: 'gen',
  // ESG (esg) - 3개
  sri_bond_info: 'esg', esg_index_info: 'esg', esg_etp_info: 'esg'
};

function getKrxApiKey(): string {
  const key = process.env.KRX_API_KEY?.trim();
  if (!key) throw new Error('KRX_API_KEY 환경변수가 설정되지 않았습니다. (openapi.krx.co.kr 발급 키 필요)');
  return key;
}

export async function fetchKrx(apiId: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return krxQueue(async () => {
    const apiKey = getKrxApiKey();
    let cleanId = apiId.trim();
    let category = KRX_CATEGORY_MAP[cleanId];

    if (!category && cleanId.includes('/')) {
      const parts = cleanId.split('/').filter(Boolean);
      if (parts.length === 2) {
        category = parts[0];
        cleanId = parts[1];
      }
    }

    if (!category) {
      throw new Error(`[KRX 오류] 지원하지 않는 API ID입니다: "${apiId}". 31개 공식 ID 중 하나를 지정해주세요.`);
    }

    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') searchParams.set(k, String(v));
    }

    const qs = searchParams.toString();
    const url = `${KRX_BASE_URL}/${category}/${cleanId}${qs ? `?${qs}` : ''}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'AUTH_KEY': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`[KRX HTTP ${res.status}] ${text.slice(0, 300).trim()}`);

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`KRX 응답이 JSON 형식이 아닙니다: ${text.slice(0, 300).trim()}`);
    }

    if (json?.error || json?.error_code || json?.result?._error_code) {
      const code = json?.error_code || json?.result?._error_code || 'ERROR';
      const msg = json?.error_message || json?.result?._error_message || json?.error || '거래소 오류';
      throw new Error(`[KRX API 오류 ${code}] ${msg}`);
    }

    // 원본 JSON 그대로 반환 (가공 없음)
    return json;
  });
}

// ============================================================================
// 3. 금융감독원 Open DART API
// ============================================================================
const DART_BASE_URL = 'https://opendart.fss.or.kr/api';
const CACHE_FILE = path.join(os.tmpdir(), 'krxdart_corp_codes.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DART_STATUS_MESSAGES: Record<string, string> = {
  '010': '등록되지 않은 키입니다.',
  '011': '사용할 수 없는 키입니다.',
  '012': '접근할 수 없는 IP입니다.',
  '013': '조회된 데이터가 없습니다.',
  '014': '파일이 존재하지 않습니다.',
  '020': '일일 호출 한도(10,000회)를 초과했습니다.',
  '021': '조회 가능한 회사 개수가 초과되었습니다.',
  '100': '필수 파라미터가 누락되었거나 부적절한 값입니다.',
  '800': '시스템 점검 중입니다.'
};

function getDartApiKey(): string {
  const key = process.env.DART_API_KEY?.trim();
  if (!key) throw new Error('DART_API_KEY 환경변수가 설정되지 않았습니다. (opendart.fss.or.kr 발급 키 필요)');
  return key;
}

export function decodeBuffer(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

export async function fetchDart(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const cleanEndpoint = endpoint.trim().replace(/^\/+/, '');
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(cleanEndpoint)) {
    throw new Error(`[DART 오류] 올바른 JSON 엔드포인트 파일명이 아닙니다: "${endpoint}"`);
  }

  return dartQueue(async () => {
    const key = getDartApiKey();
    const searchParams = new URLSearchParams({ crtfc_key: key });
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') searchParams.set(k, String(v));
    }

    const res = await fetch(`${DART_BASE_URL}/${cleanEndpoint}?${searchParams}`, {
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) throw new Error(`[DART HTTP ${res.status}] ${res.statusText}`);

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`DART 응답이 JSON 형식이 아닙니다: ${text.slice(0, 300)}`);
    }

    if (json?.status && json.status !== '000') {
      const desc = DART_STATUS_MESSAGES[json.status] || json.message || '알 수 없는 오류';
      throw new Error(`[DART 오류 ${json.status}] ${desc}`);
    }

    // 원본 JSON 그대로 반환 (가공 없음)
    return json;
  });
}

export async function fetchDartDocument(rceptNo: string, maxChars: number = 0): Promise<unknown> {
  return dartQueue(async () => {
    const key = getDartApiKey();
    const url = `${DART_BASE_URL}/document.xml?crtfc_key=${key}&rcept_no=${rceptNo}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`DART 문서 다운로드 실패: HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      const errorText = decodeBuffer(buffer);
      const msgMatch = errorText.match(/<message>([^<]*)<\/message>/);
      const statusMatch = errorText.match(/<status>([^<]*)<\/status>/);
      const status = statusMatch?.[1];
      const desc = (status && DART_STATUS_MESSAGES[status]) || msgMatch?.[1] || errorText.slice(0, 300);
      throw new Error(`[DART 문서 오류 ${status ?? 'ERROR'}] ${desc}`);
    }

    const TEXT_EXTS = new Set(['.xml', '.html', '.htm', '.xhtml', '.txt', '.json', '.csv']);
    const zip = new AdmZip(buffer);
    const files = zip.getEntries().map((entry) => {
      const ext = path.extname(entry.entryName).toLowerCase();
      if (!TEXT_EXTS.has(ext)) {
        return {
          name: entry.entryName,
          size: entry.header.size,
          content: `[첨부 바이너리 파일: ${entry.entryName} (${(entry.header.size / 1024).toFixed(1)} KB) - 텍스트 추출 대상 아님]`
        };
      }

      let content = decodeBuffer(entry.getData());
      const originalLength = content.length;
      if (maxChars > 0 && content.length > maxChars) {
        content = content.slice(0, maxChars) +
          `\n\n...[글자 수 제한으로 인해 생략됨 (총 ${originalLength.toLocaleString()}자 중 ${maxChars.toLocaleString()}자 반환)]...`;
      }
      return {
        name: entry.entryName,
        size: entry.header.size,
        content
      };
    });

    return {
      rcept_no: rceptNo,
      direct_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`,
      files
    };
  });
}

// ============================================================================
// 4. 고유번호/종목코드 검색 (corpCode.xml)
// ============================================================================
export interface CorpItem {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  modify_date: string;
}

let corpCache: CorpItem[] | null = null;
let loadPromise: Promise<CorpItem[]> | null = null;
const stockIndex = new Map<string, CorpItem>();
const corpIndex = new Map<string, CorpItem>();

function setIndexes(items: CorpItem[]) {
  stockIndex.clear();
  corpIndex.clear();
  for (const it of items) {
    if (it.stock_code) stockIndex.set(it.stock_code, it);
    if (it.corp_code) corpIndex.set(it.corp_code, it);
  }
}

async function loadCorpList(): Promise<CorpItem[]> {
  if (corpCache) return corpCache;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const stats = fs.statSync(CACHE_FILE);
        if (Date.now() - stats.mtimeMs < CACHE_TTL_MS) {
          const items: CorpItem[] = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
          if (Array.isArray(items) && items.length > 0) {
            corpCache = items;
            setIndexes(items);
            return items;
          }
        }
      }
    } catch {}

    const key = getDartApiKey();
    const res = await dartQueue(() =>
      fetch(`${DART_BASE_URL}/corpCode.xml?crtfc_key=${key}`, { signal: AbortSignal.timeout(30000) })
    );
    if (!res.ok) throw new Error(`corpCode 다운로드 실패: HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      const errorText = decodeBuffer(buffer);
      const msgMatch = errorText.match(/<message>([^<]*)<\/message>/);
      throw new Error(`[DART corpCode 오류] ${msgMatch ? msgMatch[1] : errorText.slice(0, 200)}`);
    }

    const zip = new AdmZip(buffer);
    const xmlEntry = zip.getEntries().find((e) => e.entryName.endsWith('.xml'));
    if (!xmlEntry) throw new Error('corpCode ZIP 내 XML 파일 없음');

    const xmlText = decodeBuffer(xmlEntry.getData());
    const items: CorpItem[] = [];
    const listRegex = /<list>([\s\S]*?)<\/list>/g;
    let match: RegExpExecArray | null;

    while ((match = listRegex.exec(xmlText)) !== null) {
      const b = match[1];
      const corp_code = b.match(/<corp_code>([^<]*)<\/corp_code>/)?.[1]?.trim() || '';
      const corp_name = b.match(/<corp_name>([^<]*)<\/corp_name>/)?.[1]?.trim() || '';
      const stock_code = b.match(/<stock_code>([^<]*)<\/stock_code>/)?.[1]?.trim() || '';
      const modify_date = b.match(/<modify_date>([^<]*)<\/modify_date>/)?.[1]?.trim() || '';
      if (corp_code) items.push({ corp_code, corp_name, stock_code, modify_date });
    }

    // 원자적 파일 쓰기 (tmp -> rename)
    const tmp = `${CACHE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(items), 'utf-8');
      fs.renameSync(tmp, CACHE_FILE);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
    }

    corpCache = items;
    setIndexes(items);
    return items;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export async function searchCorpCode(query: string, limit = 10): Promise<CorpItem[]> {
  const items = await loadCorpList();
  const q = query.trim();

  // 1. 종목코드 6자리 O(1)
  if (/^\d{6}$/.test(q)) {
    const found = stockIndex.get(q);
    return found ? [found] : [];
  }
  // 2. 고유번호 8자리 O(1)
  if (/^\d{8}$/.test(q)) {
    const found = corpIndex.get(q);
    return found ? [found] : [];
  }

  // 3. 회사명 부분 일치 검색
  const qLower = q.toLowerCase();
  const results: CorpItem[] = [];
  for (const it of items) {
    if (it.corp_name.toLowerCase().includes(qLower)) {
      results.push(it);
      if (results.length >= limit) break;
    }
  }
  return results;
}

// ============================================================================
// 5. MCP 서버 및 4대 도구 등록 (전수 카탈로그 명시)
// ============================================================================
const server = new McpServer({
  name: 'krxdart-mcp',
  version: '1.0.0'
});

async function safeTool(action: () => Promise<unknown>) {
  try {
    const data = await action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text' as const, text: `오류 발생: ${msg}` }] };
  }
}

// [도구 1: 한국거래소(KRX) 공식 31개 서비스 오픈API]
server.tool(
  'call_krx_api',
  '한국거래소(KRX) 공식 오픈API(openapi.krx.co.kr)를 호출하여 원본 JSON을 가공 없이 그대로 반환합니다. (KRX_API_KEY 자동 주입)',
  {
    api_id: z.string().trim().min(1).describe(
      'KRX 공식 31개 서비스 API ID 카탈로그:\n' +
      '- 주식(8): stk_bydd_trd(코스피 일별매매), ksq_bydd_trd(코스닥 일별매매), knx_bydd_trd(코넥스), stk_isu_base_info(코스피 종목정보), ksq_isu_base_info(코스닥 종목정보), knx_isu_base_info, sw_bydd_trd(신주인수권증권), sr_bydd_trd(신주인수권증서)\n' +
      '- ETP(3): etf_bydd_trd(ETF 일별매매), etn_bydd_trd(ETN), elw_bydd_trd(ELW)\n' +
      '- 지수(5): krx_dd_trd(KRX시리즈), kospi_dd_trd(KOSPI지수), kosdaq_dd_trd(KOSDAQ지수), bon_dd_trd(채권지수), drvprod_dd_trd(파생상품지수)\n' +
      '- 채권(3): kts_bydd_trd(국채전문), bnd_bydd_trd(일반채권), smb_bydd_trd(소액채권)\n' +
      '- 파생상품(6): fut_bydd_trd(선물), opt_bydd_trd(옵션), eqsfu_stk_bydd_trd(주식선물유가), eqkfu_ksq_bydd_trd(주식선물코스닥), eqsop_bydd_trd(주식옵션유가), eqkop_bydd_trd(주식옵션코스닥)\n' +
      '- 일반상품(3): gold_bydd_trd(금), oil_bydd_trd(석유), ets_bydd_trd(배출권)\n' +
      '- ESG(3): sri_bond_info(사회책임투자채권), esg_index_info(ESG지수), esg_etp_info(ESG증권상품)'
    ),
    params: z.record(z.string(), z.unknown()).optional().default({}).describe('요청 파라미터 객체 (예: basDt: "20240315", isin: "KR7005930003", isuCd: "005930" 등)')
  },
  async ({ api_id, params }) => safeTool(() => fetchKrx(api_id, params))
);

// [도구 2: 금융감독원 Open DART 70여 개 공식 엔드포인트]
server.tool(
  'call_dart_api',
  '금융감독원 Open DART의 모든 공식 엔드포인트를 호출하여 원본 JSON을 가공 없이 그대로 반환합니다. (DART_API_KEY 자동 주입)',
  {
    endpoint: z.string().trim().describe(
      'DART 공식 JSON 엔드포인트 카탈로그:\n' +
      '- 공시검색/개황: list.json(공시검색), company.json(기업개황)\n' +
      '- 재무제표: fnlttSinglAcnt.json(단일회사 주요계정), fnlttMultiAcnt.json(다중회사 최대 10개사 주요계정 일괄비교), fnlttSinglAcntAll.json(단일회사 전체 재무제표)\n' +
      '- 정기보고서 주요정보: alotMatter.json(배당), hyslrSttus.json(최대주주), hyslrChgSttus.json(최대주주변동), mrhlSttus.json(소액주주), exctvSttus.json(임원), empSttus.json(직원), indvdlByPay.json(5억이상보수), hmvAuditIndvdlBySttus.json(이사감사보수), otrCprInvstmntSttus.json(타법인출자), crpTotlIdex.json(증자감자), tesstkAcqDspsSttus.json(자기주식)\n' +
      '- 지분공시: majorstock.json(대량보유 5% 보고), elestock.json(임원/주요주주 소유상황)\n' +
      '- 주요사항보고서: ic.json(유상증자), fcr.json(무상증자), cr.json(유무상증자), rd.json(감자), act.json(자기주식취득), dst.json(자기주식처분), cvbd.json(전환사채), bw.json(신주인수권부사채), eb.json(교환사채), mrg.json(합병), div.json(분할), atras.json(자산양수도), obpr.json(주식양수), ospr.json(주식양도) 등 24종'
    ),
    params: z.record(z.string(), z.unknown()).optional().default({}).describe('DART 요청 파라미터 객체 (예: corp_code, bsns_year: "2023", reprt_code: "11011"[사업보고서], "11012"[반기], "11013"[1분기], "11014"[3분기] 등)')
  },
  async ({ endpoint, params }) => safeTool(() => fetchDart(endpoint, params))
);

// [도구 3: DART 공시 원문 ZIP 문서 다운로드 (글자수 가드 포함)]
server.tool(
  'download_dart_document',
  'DART 공시 접수번호(14자리)의 공시서류(ZIP)를 다운로드하여 텍스트 본문과 웹 링크를 반환합니다. (반환된 direct_url은 원문 열람 공식 링크입니다)',
  {
    rcept_no: z.string().regex(/^\d{14}$/, '14자리 숫자 접수번호여야 합니다 (예: 20240312000784).'),
    max_chars: z.number().int().min(0).default(0).describe('반환할 파일당 최대 글자 수 (기본값: 0, 제한 없이 원문 전체 반환). 특정 글자 수로 제한할 경우에만 양수로 지정.')
  },
  async ({ rcept_no, max_chars }) => safeTool(() => fetchDartDocument(rcept_no, max_chars))
);

// [도구 4: 회사명 / 종목코드 / 고유번호 검색]
server.tool(
  'search_corp_code',
  '회사명, 6자리 종목코드, 또는 8자리 고유번호로 기업을 검색합니다. (사명 변경 영향을 피하려면 6자리 종목코드[예: 005930] 검색 권장)',
  {
    query: z.string().trim().min(1, '검색어를 입력해주세요.').describe('회사명(예: 삼성전자), 6자리 종목코드(005930), 또는 8자리 고유번호'),
    limit: z.number().int().min(1).max(50).default(10).describe('반환할 최대 결과 수')
  },
  async ({ query, limit }) => safeTool(() => searchCorpCode(query, limit))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('krxdart-mcp 서버 실행 실패:', err);
  process.exit(1);
});

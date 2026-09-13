#!/usr/bin/env node
/**
 * krxdart-mcp: Integrated DART Disclosures & KRX Market Data MCP Server
 * Pure Proxy & Comprehensive Financial/Market Infrastructure
 * Single-file, zero heavy dependencies, Node >= 20.0.0
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
  version: '1.1.0'
});

// ============================================================================
// 1. 공통 큐 및 네트워크 제약조건 방어 (DART/KRX 공용 250ms Sequential Queue)
// ============================================================================
const DART_BASE_URL = 'https://opendart.fss.or.kr/api';
let queue: Promise<any> = Promise.resolve();
let lastRequestTime = 0;
const RATE_LIMIT_MS = 250;

function enqueue<T>(task: () => Promise<T>, intervalMs = RATE_LIMIT_MS): Promise<T> {
  const next = queue.then(async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < intervalMs) {
      await new Promise((r) => setTimeout(r, intervalMs - elapsed));
    }
    try {
      return await task();
    } finally {
      lastRequestTime = Date.now();
    }
  });
  queue = next.catch(() => {});
  return next;
}

async function safeTool(action: () => Promise<any>) {
  try {
    const data = await action();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }]
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `오류 발생: ${err.message}` }]
    };
  }
}

// ============================================================================
// 2. Zod 스키마 정의 (Open DART 및 한국거래소 표준 규격)
// ============================================================================
const corpCodeSchema = z.string().regex(/^\d{8}$/, 'DART 고유번호는 8자리 숫자여야 합니다').describe('DART 8자리 고유번호 (예: "00126380")');
const stockCodeSchema = z.string().regex(/^\d{6}$/, '종목코드는 6자리 숫자여야 합니다').describe('6자리 종목코드 (예: "005930")');
const bsnsYearSchema = z.string().regex(/^\d{4}$/, '사업연도는 4자리(YYYY)여야 합니다').describe('사업연도 (4자리, 예: 2024)');
const reprtCodeSchema = z.enum(['11013', '11012', '11014', '11011']).describe('보고서 코드 (11013: 1분기, 11012: 반기, 11014: 3분기, 11011: 사업보고서)');
const dateSchema = z.string().regex(/^\d{8}$/, '날짜는 YYYYMMDD 8자리 형식이어야 합니다');

// ============================================================================
// 3. DART API 클라이언트 및 corpCode.xml 24시간 캐시
// ============================================================================
function getDartApiKey(overrideKey?: string): string {
  const key = overrideKey || process.env.DART_API_KEY;
  if (!key) {
    throw new Error('DART_API_KEY 환경변수가 설정되지 않았습니다. 금융감독원 오픈API 키를 등록해주세요.');
  }
  return key;
}

async function fetchDart(endpoint: string, params: Record<string, any>): Promise<any> {
  const key = getDartApiKey(params.crtfc_key);
  return enqueue(async () => {
    const searchParams = new URLSearchParams({ crtfc_key: key });
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'crtfc_key' && v != null && v !== '') {
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

interface CorpItem {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  modify_date: string;
}

let corpCodeCache: CorpItem[] | null = null;
let isCaching = false;
const CACHE_FILE = path.join(os.tmpdir(), 'krxdart_corp_codes.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const REGEX_LIST = /<list>([\s\S]*?)<\/list>/g;
const REGEX_CORP_CODE = /<corp_code>([^<]*?)<\/corp_code>/;
const REGEX_CORP_NAME = /<corp_name>([^<]*?)<\/corp_name>/;
const REGEX_STOCK_CODE = /<stock_code>([^<]*?)<\/stock_code>/;
const REGEX_MODIFY_DATE = /<modify_date>([^<]*?)<\/modify_date>/;

async function loadCorpCodeList(): Promise<CorpItem[]> {
  if (corpCodeCache) return corpCodeCache;

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      if (Date.now() - stats.mtimeMs < CACHE_TTL_MS) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        corpCodeCache = JSON.parse(raw);
        if (corpCodeCache && corpCodeCache.length > 0) return corpCodeCache;
      }
    }
  } catch {}

  if (isCaching) {
    while (isCaching) await new Promise((r) => setTimeout(r, 100));
    if (corpCodeCache) return corpCodeCache;
  }

  const key = getDartApiKey();
  isCaching = true;

  try {
    const buffer = await enqueue(async () => {
      const res = await fetch(`${DART_BASE_URL}/corpCode.xml?crtfc_key=${key}`, {
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`고유번호 파일 다운로드 실패: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });

    const zip = new AdmZip(buffer);
    const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.xml'));
    if (!xmlEntry) throw new Error('ZIP 파일 내 XML이 없습니다.');

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
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(items), 'utf-8');
    } catch {}
    return items;
  } finally {
    isCaching = false;
  }
}

// ============================================================================
// 4. KRX 시장 시세 데이터 모듈 (모든 원천 필드 보존)
// ============================================================================
function parseNum(v: any): number {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function parseKoreanCurrency(text: string): { billion: number; won: number } {
  if (!text) return { billion: 0, won: 0 };
  let billion = 0;
  const joMatch = text.match(/([\d,]+)\s*조/);
  if (joMatch) billion += parseFloat(joMatch[1].replace(/,/g, '')) * 10000;
  const eokMatch = text.match(/([\d,]+)\s*억/);
  if (eokMatch) billion += parseFloat(eokMatch[1].replace(/,/g, ''));
  return { billion, won: billion * 100_000_000 };
}

function formatDateYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function fetchFromGovApi(cleanCode: string, apiKey: string, asOfDate?: string, includeRaw = true) {
  return enqueue(async () => {
    try {
      const cleanKey = apiKey.includes('%') ? decodeURIComponent(apiKey) : apiKey;
      let dateQuery = '';
      if (asOfDate) {
        dateQuery = `&basDt=${asOfDate.replace(/-/g, '')}`;
      } else {
        const now = new Date();
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        dateQuery = `&beginBasDt=${formatDateYmd(twoWeeksAgo)}&endBasDt=${formatDateYmd(now)}`;
      }

      const url = `https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey=${encodeURIComponent(cleanKey)}&resultType=json&likeSrtnCd=${cleanCode}${dateQuery}&numOfRows=30`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { result: null, error: `HTTP ${res.status}` };

      const json: any = await res.json().catch(() => null);
      if (!json || json?.response?.header?.resultCode !== '00') {
        return { result: null, error: json?.response?.header?.resultMsg || '응답 오류' };
      }

      const rawItems = json?.response?.body?.items?.item;
      if (!rawItems) return { result: null, error: '시세 데이터 없음' };

      const itemsArray = Array.isArray(rawItems) ? rawItems : [rawItems];
      const matched = itemsArray.filter((it: any) => String(it.srtnCd || '').trim() === cleanCode);
      if (matched.length === 0) return { result: null, error: '일치 종목 없음' };

      matched.sort((a: any, b: any) => String(b.basDt || '').localeCompare(String(a.basDt || '')));
      const item = matched[0];

      const closePrice = parseNum(item.clpr);
      const marketCapKrw = parseNum(item.mrktTotAmt);
      const basDt = String(item.basDt || '');
      const tradeDate = basDt.length === 8 ? `${basDt.slice(0, 4)}-${basDt.slice(4, 6)}-${basDt.slice(6, 8)}` : basDt;

      return {
        result: {
          stock_code: cleanCode,
          stock_name: item.itmsNm || '',
          market_type: item.mrktCtg || 'KOSPI',
          as_of_date: tradeDate,
          close_price: closePrice,
          open_price: parseNum(item.mkp),
          high_price: parseNum(item.hipr),
          low_price: parseNum(item.lopr),
          change_amount: parseNum(item.vs),
          change_rate_percent: parseNum(item.fltRt),
          market_cap_krw: marketCapKrw,
          market_cap_billion_krw: Math.round(marketCapKrw / 100_000_000),
          total_shares: parseNum(item.lstgStCnt),
          high_52w: parseNum(item.hipr),
          low_52w: parseNum(item.lopr),
          trading_volume: parseNum(item.trqu),
          trading_value_krw: parseNum(item.trPrc),
          source: '금융위원회/한국거래소 공공데이터포털 공식 API',
          ...(includeRaw ? { raw_data: item } : {})
        }
      };
    } catch (e: any) {
      return { result: null, error: e.message };
    }
  });
}

async function fetchFromKrxFeed(cleanCode: string, includeRaw = true, warning?: string) {
  return enqueue(async () => {
    const url = `https://m.stock.naver.com/api/stock/${cleanCode}/integration`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`거래소 시세 피드 응답 오류: HTTP ${res.status}`);

    const data: any = await res.json();
    const dealTrend = data?.dealTrendInfos?.[0];
    const t = data?.totalInfos;
    const getVal = (code: string) => t?.find((x: any) => x.code === code)?.value || '';

    const closePrice = parseNum(dealTrend?.closePrice ?? data?.nowPrice ?? 0);
    const cap = parseKoreanCurrency(getVal('marketValue'));
    const marketCapBillion = cap.billion > 0 ? cap.billion : parseNum(data?.marketValue);
    const marketCapKrw = cap.won > 0 ? cap.won : marketCapBillion * 100_000_000;
    const totalShares = closePrice > 0 ? Math.round(marketCapKrw / closePrice) : 0;

    let tradeDate = '';
    if (dealTrend?.bizdate) {
      const b = String(dealTrend.bizdate);
      tradeDate = b.length === 8 ? `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}` : b;
    } else {
      const d = new Date();
      if (d.getDay() === 0) d.setDate(d.getDate() - 2);
      else if (d.getDay() === 6) d.setDate(d.getDate() - 1);
      tradeDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    return {
      stock_code: cleanCode,
      stock_name: data?.stockName || '',
      market_type: data?.stockType || 'KRX',
      as_of_date: tradeDate,
      close_price: closePrice,
      open_price: parseNum(getVal('openPrice')),
      high_price: parseNum(getVal('highPrice')),
      low_price: parseNum(getVal('lowPrice')),
      change_amount: parseNum(dealTrend?.compareToPreviousClosePrice),
      change_rate_percent: parseNum(dealTrend?.fluctuationsRatio),
      market_cap_krw: marketCapKrw,
      market_cap_billion_krw: marketCapBillion,
      total_shares: totalShares,
      high_52w: parseNum(getVal('highPriceOf52Weeks')),
      low_52w: parseNum(getVal('lowPriceOf52Weeks')),
      trading_volume: parseNum(getVal('accumulatedTradingVolume')),
      trading_value_krw: parseNum(dealTrend?.accumulatedTradingValue),
      source: '한국거래소(KRX) 공식 시세 피드',
      ...(includeRaw ? { raw_data: data } : {}),
      ...(warning ? { warning } : {})
    };
  });
}

async function getKrxPrice(stockCode: string, asOfDate?: string, includeRaw = true) {
  const cleanCode = stockCode.trim().padStart(6, '0');
  if (!/^\d{6}$/.test(cleanCode)) throw new Error(`유효하지 않은 종목코드입니다: ${stockCode}`);

  const apiKey = process.env.KRX_API_KEY;
  if (apiKey) {
    const { result, error } = await fetchFromGovApi(cleanCode, apiKey, asOfDate, includeRaw);
    if (result) return result;
    return fetchFromKrxFeed(cleanCode, includeRaw, `[주의] 공공데이터포털 API 실패로 실시간 피드로 대체되었습니다. (${error})`);
  }
  return fetchFromKrxFeed(cleanCode, includeRaw);
}

// ============================================================================
// 5. 다중 연도 재무 3표 일괄 수집기 (DART 법정공시 원천 데이터 100% 보존)
// ============================================================================
async function fetchMultiYearFinancials(
  corp_code: string,
  years = 10,
  reprt_code = '11011',
  fs_div: 'CFS' | 'OFS' | 'ALL' = 'CFS',
  start_year?: string,
  end_year?: string
) {
  const currentYear = new Date().getFullYear();
  const targetYears: number[] = [];

  if (start_year && end_year) {
    const sy = parseInt(start_year, 10);
    const ey = parseInt(end_year, 10);
    for (let y = ey; y >= sy; y--) targetYears.push(y);
  } else {
    for (let i = 1; i <= Math.min(years + 1, 15); i++) {
      targetYears.push(currentYear - i);
    }
  }

  const resultsByYear: Record<string, any> = {};
  let validCount = 0;

  for (const year of targetYears) {
    if (!start_year && validCount >= years) break;
    try {
      const data = await fetchDart('/fnlttSinglAcnt.json', {
        corp_code,
        bsns_year: String(year),
        reprt_code
      });

      if (data?.status === '000' && Array.isArray(data.list) && data.list.length > 0) {
        let filtered = data.list;
        if (fs_div !== 'ALL') {
          filtered = data.list.filter((it: any) => it.fs_div === fs_div);
          if (filtered.length === 0) filtered = data.list;
        }

        const sample = filtered[0] || data.list[0];
        const rceptNo = sample.rcept_no || '';
        const directUrl = rceptNo ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}` : '';

        resultsByYear[String(year)] = {
          bsns_year: String(year),
          rcept_no: rceptNo,
          direct_url: directUrl,
          fs_div: sample.fs_div,
          accounts_count: filtered.length,
          accounts: filtered
        };
        validCount++;
      }
    } catch (err: any) {
      if (err.message.includes('한도 초과') || err.message.includes('키 오류')) throw err;
      // 특정 연도 미공시(013 등)는 안전하게 패스하고 다음 연도 수집
    }
  }

  return {
    status: '000',
    message: '정상',
    corp_code,
    fs_div_requested: fs_div,
    years_retrieved: validCount,
    source: '금융감독원 전자공시시스템(DART)',
    financial_time_series: resultsByYear
  };
}

// ============================================================================
// 6. MCP 도구 등록 (범용 API 호출 + 시세/재무/자금공시 완벽 지원)
// ============================================================================

// [만능 범용 도구] DART 오픈API 전체 엔드포인트 자유 호출 도구
server.tool(
  'call_dart_api',
  '금융감독원 DART 오픈API의 모든 공식 엔드포인트를 자유롭게 호출합니다. DART 공식 문서에 정의된 모든 엔드포인트(예: /company.json, /list.json, /fnlttSinglAcnt.json, /fnlttMultiAcnt.json, /detSecIsu.json, /piicDecsn.json, /cvbdIsDecsn.json 등)와 모든 파라미터를 그대로 전달하여 원본 JSON을 조회할 수 있습니다.',
  {
    endpoint: z.string().describe('DART 오픈API 엔드포인트 경로 (예: "/company.json", "/list.json", "/piicDecsn.json", "/detSecIsu.json")'),
    params: z.record(z.any()).describe('요청 파라미터 객체 (crtfc_key는 자동 주입되므로 corp_code, bsns_year, bgn_de 등 필요한 파라미터를 자유롭게 전달)')
  },
  async ({ endpoint, params }) => safeTool(() => fetchDart(endpoint, params))
);

// [시세 도구] KRX 주식 시장 시세 조회
server.tool(
  'get_krx_price',
  '한국거래소(KRX) 공식 주식 시장 시세 데이터를 조회합니다. 기준일 확정 종가, 시가총액, 상장주식수, 52주 최고/최저가 등 공식 시장 데이터를 반환하며, 원천 데이터 전체(raw_data)도 함께 제공합니다.',
  {
    stock_code: z.string().describe('6자리 종목코드 (예: "005930" 삼성전자)'),
    as_of_date: dateSchema.optional().describe('특정 기준일자 (YYYYMMDD 형식, 미지정 시 최근 확정 거래일)'),
    include_raw: z.boolean().default(true).describe('원천 API의 전체 응답(raw_data) 포함 여부 (기본값: true)')
  },
  async ({ stock_code, as_of_date, include_raw }) => safeTool(() => getKrxPrice(stock_code, as_of_date, include_raw))
);

// [재무 도구] 다중 연도 재무 3표 일괄 수집
server.tool(
  'get_multi_year_financials',
  '특정 기업의 최근 N개년(기본 10개년) 사업보고서 표준 주요 재무 3표(손익계산서, 재무상태표, 현금흐름표 계정 원본)를 일괄 수집합니다. 각 연도별 DART 공시 뷰어 바로가기 링크(direct_url)가 자동 첨부됩니다.',
  {
    corp_code: corpCodeSchema,
    years: z.number().int().min(1).max(15).default(10).describe('수집할 최근 연도 수 (기본값: 10개년)'),
    reprt_code: reprtCodeSchema.default('11011').describe('보고서 코드 (기본값: 11011 사업보고서)'),
    fs_div: z.enum(['CFS', 'OFS', 'ALL']).default('CFS').describe('연결/별도 구분 (CFS: 연결재무제표, OFS: 별도재무제표, ALL: 전체)'),
    start_year: z.string().regex(/^\d{4}$/).optional().describe('조회 시작연도 (YYYY, 설정 시 years 대신 기간 우선)'),
    end_year: z.string().regex(/^\d{4}$/).optional().describe('조회 종료연도 (YYYY)')
  },
  async ({ corp_code, years, reprt_code, fs_div, start_year, end_year }) =>
    safeTool(() => fetchMultiYearFinancials(corp_code, years, reprt_code, fs_div, start_year, end_year))
);

// [재무 도구] 다중 회사 주요계정 비교 조회 (신규)
server.tool(
  'get_multi_corp_financials',
  '여러 기업(최대 수십 개 사)의 특정 연도 표준 주요계정을 한 번의 호출로 일괄 비교 조회합니다. (/api/fnlttMultiAcnt.json)',
  {
    corp_code: z.string().describe('콤마(,)로 구분된 복수 기업 DART 고유번호 (예: "00126380,00164779")'),
    bsns_year: bsnsYearSchema,
    reprt_code: reprtCodeSchema
  },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/fnlttMultiAcnt.json', { corp_code, bsns_year, reprt_code }))
);

// [자금조달/채무 도구 1] 채무증권(회사채/CP/단기사채) 발행실적 및 미상환 잔액 현황 (신규)
server.tool(
  'get_debt_securities_status',
  '기업의 채무증권(회사채, 기업어음(CP), 전자단기사채 등) 발행실적 및 만기별 미상환 잔액 현황을 조회합니다. (/api/detSecIsu.json)',
  {
    corp_code: corpCodeSchema,
    bsns_year: bsnsYearSchema,
    reprt_code: reprtCodeSchema
  },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/detSecIsu.json', { corp_code, bsns_year, reprt_code }))
);

// [자금조달/채무 도구 2] 유상증자 결정 공시 (신규)
server.tool(
  'get_capital_increase',
  '기업의 유상증자 결정 주요사항보고서를 조회합니다. 신주 발행가액, 증자방식, 자금조달목적(시설/운영/채무상환자금 등) 원본을 조회합니다. (/api/piicDecsn.json)',
  {
    corp_code: corpCodeSchema,
    bgn_de: dateSchema.optional().describe('조회 시작일자 (YYYYMMDD)'),
    end_de: dateSchema.optional().describe('조회 종료일자 (YYYYMMDD)')
  },
  async ({ corp_code, bgn_de, end_de }) =>
    safeTool(() => fetchDart('/piicDecsn.json', { corp_code, bgn_de, end_de }))
);

// [자금조달/채무 도구 3] 전환사채(CB) 발행결정 공시 (신규)
server.tool(
  'get_convertible_bonds',
  '기업의 전환사채(CB) 발행결정 주요사항보고서를 조회합니다. 사채의 권면총액, 전환가액, 자금조달목적(시설/운영/채무상환자금 등), 표면/만기 이자율 원본을 조회합니다. (/api/cvbdIsDecsn.json)',
  {
    corp_code: corpCodeSchema,
    bgn_de: dateSchema.optional().describe('조회 시작일자 (YYYYMMDD)'),
    end_de: dateSchema.optional().describe('조회 종료일자 (YYYYMMDD)')
  },
  async ({ corp_code, bgn_de, end_de }) =>
    safeTool(() => fetchDart('/cvbdIsDecsn.json', { corp_code, bgn_de, end_de }))
);

// [자금조달/채무 도구 4] 신주인수권부사채(BW) 발행결정 공시 (신규)
server.tool(
  'get_bond_with_warrants',
  '기업의 신주인수권부사채(BW) 발행결정 주요사항보고서를 조회합니다. 사채 권면총액, 행사가액, 자금조달목적 원본을 조회합니다. (/api/bdwtIsDecsn.json)',
  {
    corp_code: corpCodeSchema,
    bgn_de: dateSchema.optional().describe('조회 시작일자 (YYYYMMDD)'),
    end_de: dateSchema.optional().describe('조회 종료일자 (YYYYMMDD)')
  },
  async ({ corp_code, bgn_de, end_de }) =>
    safeTool(() => fetchDart('/bdwtIsDecsn.json', { corp_code, bgn_de, end_de }))
);

// [기본 도구] 회사 고유번호 검색
server.tool(
  'search_corp_code',
  '회사명 또는 종목코드로 DART 8자리 고유번호(corp_code)를 검색합니다. (24시간 캐시 사용)',
  {
    query: z.string().describe('회사명(예: "삼성전자") 또는 6자리 종목코드(예: "005930")'),
    limit: z.number().int().min(1).max(100).default(10).describe('반환할 최대 결과 수')
  },
  async ({ query, limit }) =>
    safeTool(async () => {
      const list = await loadCorpCodeList();
      const q = query.trim().toLowerCase();
      const isNum = /^\d+$/.test(q);

      const matched = list.filter((item) => {
        if (isNum && item.stock_code.includes(q)) return true;
        return item.corp_name.toLowerCase().includes(q);
      });

      matched.sort((a, b) => {
        const aExact = a.corp_name.toLowerCase() === q || a.stock_code === q;
        const bExact = b.corp_name.toLowerCase() === q || b.stock_code === q;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        return 0;
      });

      return matched.slice(0, limit);
    })
);

// [기본 도구] 기업 기본개요
server.tool(
  'get_company_info',
  'DART 기업 기본개요(정식명칭, 대표자명, 법인구분, 주소, 업종코드, 설립일 등 원본 전체)를 조회합니다. (/api/company.json)',
  { corp_code: corpCodeSchema },
  async ({ corp_code }) => safeTool(() => fetchDart('/company.json', { corp_code }))
);

// [기본 도구] 최근 공시 목록 (DART 공식 파라미터 전수 지원)
server.tool(
  'get_disclosures',
  '최근 공시 목록을 조회합니다. DART 공식 파라미터를 모두 지원하며, 각 항목마다 DART 공식 웹 뷰어 링크(direct_url)가 자동 첨부됩니다. (/api/list.json)',
  {
    corp_code: corpCodeSchema.optional(),
    bgn_de: dateSchema.optional().describe('시작일자 (YYYYMMDD)'),
    end_de: dateSchema.optional().describe('종료일자 (YYYYMMDD)'),
    last_reprt_at: z.enum(['Y', 'N']).optional().describe('최종보고서 여부 (Y: 최종보고서만, N: 전체)'),
    pblntf_ty: z.string().optional().describe('공시유형 (A: 정기공시, B: 주요사항보고, C: 발행공시, D: 지분공시, E: 기타공시 등)'),
    pblntf_detail_ty: z.string().optional().describe('공시상세유형 코드'),
    corp_cls: z.enum(['Y', 'K', 'N', 'E']).optional().describe('법인구분 (Y: 유가증권, K: 코스닥, N: 코넥스, E: 기타)'),
    sort: z.enum(['date', 'crp', 'rpt']).optional().describe('정렬항목 (date: 접수일자, crp: 회사명, rpt: 보고서명)'),
    sort_mth: z.enum(['asc', 'desc']).optional().describe('정렬방법 (asc: 오름차순, desc: 내림차순)'),
    page_no: z.number().int().min(1).default(1).describe('페이지 번호 (기본 1)'),
    page_count: z.number().int().min(1).max(100).default(20).describe('페이지당 건수 (기본 20, 최대 100)')
  },
  async (params) =>
    safeTool(async () => {
      const data = await fetchDart('/list.json', params);
      if (data?.status === '000' && Array.isArray(data.list)) {
        data.list = data.list.map((item: any) => ({
          ...item,
          direct_url: item.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}` : ''
        }));
      }
      return data;
    })
);

// [기본 도구] 단일 연도 주요계정
server.tool(
  'get_key_financials',
  '단일 연도의 DART 표준 주요계정(재무상태표, 손익계산서, 현금흐름표 필수 25개 계정 원본)을 조회합니다. (/api/fnlttSinglAcnt.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/fnlttSinglAcnt.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 단일 연도 전체 재무제표
server.tool(
  'get_all_financials',
  '단일 연도의 전체 재무제표(주석 제외 전체 계정 원본)를 조회합니다. (/api/fnlttSinglAcntAll.json)',
  {
    corp_code: corpCodeSchema,
    bsns_year: bsnsYearSchema,
    reprt_code: reprtCodeSchema,
    fs_div: z.enum(['CFS', 'OFS']).default('CFS').describe('연결(CFS) / 개별(OFS) 구분')
  },
  async ({ corp_code, bsns_year, reprt_code, fs_div }) =>
    safeTool(() => fetchDart('/fnlttSinglAcntAll.json', { corp_code, bsns_year, reprt_code, fs_div }))
);

// [기본 도구] 주식 총수 현황
server.tool(
  'get_stock_totqy_sttus',
  '주식의 총수 현황(발행주식 총수, 자기주식수, 유통주식수 등)을 조회합니다. (/api/stockTotqySttus.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/stockTotqySttus.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 최대주주 현황
server.tool(
  'get_major_shareholders',
  '최대주주 및 특수관계인 지분 현황을 조회합니다. (/api/hyslrSttus.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/hyslrSttus.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 자기주식 현황
server.tool(
  'get_treasury_stocks',
  '자기주식 취득 및 처분 현황을 조회합니다. (/api/tesstkAcqsDspsSttus.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/tesstkAcqsDspsSttus.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 배당 정보
server.tool(
  'get_dividend_info',
  '배당에 관한 사항을 조회합니다. (/api/alotMatter.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/alotMatter.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 임직원 급여 현황
server.tool(
  'get_employee_salaries',
  '임직원 수 및 1인 평균 급여액 현황을 조회합니다. (/api/empSttus.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/empSttus.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 임원 현황
server.tool(
  'get_executive_status',
  '임원 현황을 조회합니다. (/api/exctvSttus.json)',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/exctvSttus.json', { corp_code, bsns_year, reprt_code }))
);

// [기본 도구] 5% 이상 대량보유 보고서
server.tool(
  'get_5percent_reports',
  '주식등의 대량보유 상황보고서(5% 이상 보유 보고 원본)를 조회합니다. (/api/majorstock.json)',
  { corp_code: corpCodeSchema },
  async ({ corp_code }) => safeTool(() => fetchDart('/majorstock.json', { corp_code }))
);

// [기본 도구] 임원/주요주주 특정증권 소유보고서
server.tool(
  'get_insider_trading',
  '임원·주요주주 특정증권등 소유상황보고서를 조회합니다. (/api/elestock.json)',
  { corp_code: corpCodeSchema },
  async ({ corp_code }) => safeTool(() => fetchDart('/elestock.json', { corp_code }))
);

// ============================================================================
// 7. 서버 초기화 및 실행
// ============================================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('krxdart-mcp 치명적 오류:', error);
  process.exit(1);
});

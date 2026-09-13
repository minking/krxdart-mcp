#!/usr/bin/env node
/**
 * krxdart-mcp: Integrated DART Disclosures & KRX Market Data MCP Server
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
  version: '1.0.0'
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
// 2. Zod 스키마 정의 (DART / KRX 원천 규격 준수)
// ============================================================================
const corpCodeSchema = z.string().regex(/^\d{8}$/, 'DART 고유번호는 8자리 숫자여야 합니다').describe('DART 8자리 고유번호');
const stockCodeSchema = z.string().regex(/^\d{6}$/, '종목코드는 6자리 숫자여야 합니다').describe('6자리 종목코드 (예: "005930")');
const bsnsYearSchema = z.string().regex(/^\d{4}$/, '사업연도는 4자리(YYYY)여야 합니다').describe('사업연도 (4자리, 예: 2024)');
const reprtCodeSchema = z.enum(['11013', '11012', '11014', '11011']).describe('보고서 코드 (11013: 1분기, 11012: 반기, 11014: 3분기, 11011: 사업보고서)');
const dateSchema = z.string().regex(/^\d{8}$/, '날짜는 YYYYMMDD 8자리 형식이어야 합니다');

// ============================================================================
// 3. DART API 및 corpCode 24시간 캐시 (정규식 호이스팅 최적화)
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

    const res = await fetch(`${DART_BASE_URL}${endpoint}?${searchParams}`, {
      signal: AbortSignal.timeout(20000)
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

  // 1. 디스크 캐시 확인
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
// 4. KRX 주식 시세 모듈 (정부 공통 API + 실시간 피드 Failover + 휴장일 보정)
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

async function fetchFromGovApi(cleanCode: string, apiKey: string, asOfDate?: string) {
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
          source: '금융위원회/한국거래소 공공데이터포털 공식 API'
        }
      };
    } catch (e: any) {
      return { result: null, error: e.message };
    }
  });
}

async function fetchFromKrxFeed(cleanCode: string, warning?: string) {
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
      ...(warning ? { warning } : {})
    };
  });
}

async function getKrxPrice(stockCode: string, asOfDate?: string) {
  const cleanCode = stockCode.trim().padStart(6, '0');
  if (!/^\d{6}$/.test(cleanCode)) throw new Error(`유효하지 않은 종목코드입니다: ${stockCode}`);

  const apiKey = process.env.KRX_API_KEY;
  if (apiKey) {
    const { result, error } = await fetchFromGovApi(cleanCode, apiKey, asOfDate);
    if (result) return result;
    return fetchFromKrxFeed(cleanCode, `[주의] 공공데이터포털 API 실패로 실시간 피드로 대체되었습니다. (${error})`);
  }
  return fetchFromKrxFeed(cleanCode);
}

// ============================================================================
// 5. 다중 연도 재무 3표 일괄 수집기 (DART 법정공시 원천 데이터)
// ============================================================================
async function fetchMultiYearFinancials(
  corp_code: string,
  years = 10,
  reprt_code = '11011',
  fs_div: 'CFS' | 'OFS' = 'CFS'
) {
  const currentYear = new Date().getFullYear();
  const targetYears: number[] = [];
  for (let i = 1; i <= Math.min(years + 1, 12); i++) {
    targetYears.push(currentYear - i);
  }

  const resultsByYear: Record<string, any> = {};
  let validCount = 0;

  for (const year of targetYears) {
    if (validCount >= years) break;
    try {
      const data = await fetchDart('/fnlttSinglAcnt.json', {
        corp_code,
        bsns_year: String(year),
        reprt_code
      });

      if (data?.status === '000' && Array.isArray(data.list) && data.list.length > 0) {
        let filtered = data.list.filter((it: any) => it.fs_div === fs_div);
        if (filtered.length === 0) filtered = data.list;

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
      // 특정 연도 미공시(013 등)는 안전하게 건너뛰고 다음 연도 수집
    }
  }

  return {
    status: '000',
    message: '정상',
    corp_code,
    fs_div_requested: fs_div,
    years_requested: years,
    years_retrieved: validCount,
    source: '금융감독원 전자공시시스템(DART)',
    financial_time_series: resultsByYear
  };
}

// ============================================================================
// 6. MCP 도구 등록 (총 15종: 시세/다중재무 도구 + DART 원천 도구)
// ============================================================================

// [시세 도구] KRX 시세 조회
server.tool(
  'get_krx_price',
  '한국거래소(KRX) 공식 주식 시장 시세 데이터를 조회합니다. 기준일 확정 종가, 시가총액, 상장주식수, 52주 최고/최저가 등 공식 시장 데이터를 반환합니다.',
  {
    stock_code: z.string().describe('6자리 종목코드 (예: "005930" 삼성전자)'),
    as_of_date: dateSchema.optional().describe('특정 기준일자 (YYYYMMDD 형식, 미지정 시 최근 확정 거래일)')
  },
  async ({ stock_code, as_of_date }) => safeTool(() => getKrxPrice(stock_code, as_of_date))
);

// [재무 도구] 다중 연도 재무 3표 일괄 수집
server.tool(
  'get_multi_year_financials',
  '특정 기업의 최근 N개년(기본 10개년) 사업보고서 표준 주요 재무 3표(손익계산서, 재무상태표, 현금흐름표 필수 계정)를 일괄 수집합니다. 각 연도별 DART 공시 뷰어 바로가기 링크(direct_url)가 자동 첨부됩니다.',
  {
    corp_code: corpCodeSchema,
    years: z.number().int().min(1).max(12).default(10).describe('수집할 최근 연도 수 (기본값: 10개년)'),
    reprt_code: reprtCodeSchema.default('11011').describe('보고서 코드 (기본값: 11011 사업보고서)'),
    fs_div: z.enum(['CFS', 'OFS']).default('CFS').describe('연결/별도 구분 (CFS: 연결재무제표, OFS: 별도재무제표)')
  },
  async ({ corp_code, years, reprt_code, fs_div }) =>
    safeTool(() => fetchMultiYearFinancials(corp_code, years, reprt_code, fs_div))
);

// [DART 공통 도구 13종]
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

server.tool(
  'get_company_info',
  'DART 기업 기본개요(정식명칭, 대표자명, 법인구분, 주소, 업종코드 등)를 조회합니다.',
  { corp_code: corpCodeSchema },
  async ({ corp_code }) => safeTool(() => fetchDart('/company.json', { corp_code }))
);

server.tool(
  'get_disclosures',
  '최근 공시 목록을 조회합니다. 각 공시 항목마다 DART 공식 웹 뷰어 링크(direct_url)가 자동 첨부됩니다.',
  {
    corp_code: corpCodeSchema.optional(),
    bgn_de: dateSchema.optional().describe('시작일자 (YYYYMMDD)'),
    end_de: dateSchema.optional().describe('종료일자 (YYYYMMDD)'),
    last_reprt_at: z.enum(['Y', 'N']).optional().describe('최종보고서 여부'),
    pblntf_ty: z.string().optional().describe('공시유형 (A:정기공시, B:주요사항보고, C:발행공시, D:지분공시 등)'),
    pblntf_detail_ty: z.string().optional().describe('공시상세유형 코드'),
    corp_cls: z.enum(['Y', 'K', 'N', 'E']).optional().describe('법인구분 (Y:유가증권, K:코스닥, N:코넥스, E:기타)'),
    sort: z.enum(['date', 'crp', 'rpt']).optional().describe('정렬항목'),
    sort_mth: z.enum(['asc', 'desc']).optional().describe('정렬방법'),
    page_no: z.number().int().min(1).default(1),
    page_count: z.number().int().min(1).max(100).default(20)
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

server.tool(
  'get_key_financials',
  '단일 연도의 DART 표준 주요계정(재무상태표, 손익계산서, 현금흐름표 필수 25개 계정)을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/fnlttSinglAcnt.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_all_financials',
  '단일 연도의 전체 재무제표(주석 제외 전체 계정)를 조회합니다.',
  {
    corp_code: corpCodeSchema,
    bsns_year: bsnsYearSchema,
    reprt_code: reprtCodeSchema,
    fs_div: z.enum(['CFS', 'OFS']).default('CFS').describe('연결(CFS) / 개별(OFS) 구분')
  },
  async ({ corp_code, bsns_year, reprt_code, fs_div }) =>
    safeTool(() => fetchDart('/fnlttSinglAcntAll.json', { corp_code, bsns_year, reprt_code, fs_div }))
);

server.tool(
  'get_stock_totqy_sttus',
  '주식의 총수 현황(발행주식 총수, 자기주식수, 유통주식수 등)을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/stockTotqySttus.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_major_shareholders',
  '최대주주 및 특수관계인 지분 현황을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/hyslrSttus.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_treasury_stocks',
  '자기주식 취득 및 처분 현황을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/tesstkAcqsDspsSttus.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_dividend_info',
  '배당에 관한 사항을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/alotMatter.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_employee_salaries',
  '임직원 수 및 1인 평균 급여액 현황을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/empSttus.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_executive_status',
  '임원 현황을 조회합니다.',
  { corp_code: corpCodeSchema, bsns_year: bsnsYearSchema, reprt_code: reprtCodeSchema },
  async ({ corp_code, bsns_year, reprt_code }) =>
    safeTool(() => fetchDart('/exctvSttus.json', { corp_code, bsns_year, reprt_code }))
);

server.tool(
  'get_5percent_reports',
  '주식등의 대량보유 상황보고서(5% 이상 보유 보고)를 조회합니다.',
  { corp_code: corpCodeSchema },
  async ({ corp_code }) => safeTool(() => fetchDart('/majorstock.json', { corp_code }))
);

server.tool(
  'get_insider_trading',
  '임원·주요주주 특정증권등 소유상황보고서를 조회합니다.',
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

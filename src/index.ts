#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ============================================================================
// 1. 요청 큐 (순차 실행으로 API 호출 간격 보장)
// ============================================================================
export function createQueue(minIntervalMs: number) {
  let last = -Infinity;
  let chain: Promise<unknown> = Promise.resolve();

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
      const now = performance.now();
      const wait = minIntervalMs - (now - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = performance.now();
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
    const cleanId = apiId.trim();
    const category = KRX_CATEGORY_MAP[cleanId];

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

export function parseDartApiResponse<T = unknown>(text: string): T {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    const statusMatch = text.match(/<status>([^<]*)<\/status>/i);
    const msgMatch = text.match(/<message>([^<]*)<\/message>/i);
    if (statusMatch || msgMatch) {
      const status = statusMatch?.[1] || 'ERROR';
      const desc = (status && DART_STATUS_MESSAGES[status]) || msgMatch?.[1] || text.slice(0, 300);
      throw new Error(`[DART 오류 ${status}] ${desc}`);
    }
    throw new Error(`DART 응답이 JSON 형식이 아닙니다: ${text.slice(0, 300)}`);
  }

  if (json?.status != null) {
    const status = String(json.status).padStart(3, '0');
    if (status !== '000' && status !== '013') {
      const desc = DART_STATUS_MESSAGES[status] || json.message || '알 수 없는 오류';
      throw new Error(`[DART 오류 ${status}] ${desc}`);
    }
  }

  // 원본 JSON 그대로 반환 (가공 없음, 000 정상 조회 및 013 조회결과 0건 포함)
  return json;
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
    return parseDartApiResponse(text);
  });
}

/**
 * DART 공시 XML의 레이아웃 스타일 노이즈(컬러, 폰트, 폭/높이 속성 등)를 제거하여
 * 토큰 소모량을 대폭 줄이면서도 본문 텍스트, 수치, 표 구조(table/tr/td, colspan, rowspan)는 100% 무손실 보존합니다.
 */
export function cleanXmlContent(xml: string): string {
  return xml
    .replace(/<TU\b/gi, '<TD')
    .replace(/<\/TU>/gi, '</TD>')
    .replace(/<COLGROUP\b[^>]*\/>/gi, '')
    .replace(/<COLGROUP\b[^>]*>[\s\S]*?<\/COLGROUP>/gi, '')
    .replace(/<\/?COLGROUP\b[^>]*\/?>/gi, '')
    .replace(/<\/?COL\b[^>]*\/?>/gi, '')
    .replace(/<PGBRK\b[^>]*\/?>|<\/PGBRK>/gi, '')
    .replace(/<P\b[^>]*>\s*<\/P>|<P\b[^>]*\/>/gi, '')
    .replace(/<(TABLE|TR|TD|TH)\b([^>]*)>/gi, (_, tag, attrs) => {
      const keep: string[] = [];
      const colspanMatch = attrs.match(/\bCOLSPAN\s*=\s*(["']?\d+["']?)/i);
      const rowspanMatch = attrs.match(/\bROWSPAN\s*=\s*(["']?\d+["']?)/i);
      if (colspanMatch) keep.push(`colspan="${colspanMatch[1].replace(/['"]/g, '')}"`);
      if (rowspanMatch) keep.push(`rowspan="${rowspanMatch[1].replace(/['"]/g, '')}"`);
      const isSelfClosing = attrs.trim().endsWith('/');
      const attrStr = keep.length ? ' ' + keep.join(' ') : '';
      return `<${tag.toLowerCase()}${attrStr}${isSelfClosing ? ' />' : '>'}`;
    })
    .replace(/<\/(TABLE|TR|TD|TH)>/gi, (_, tag) => `</${tag.toLowerCase()}>`)
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * DART 공시 XML에서 문서명(<DOCUMENT-NAME>)을 추출합니다. 없으면 파일명을 반환합니다.
 */
export function extractDocTitle(xml: string, fallbackName: string): string {
  const match = xml.match(/<DOCUMENT-NAME[^>]*>([\s\S]*?)<\/DOCUMENT-NAME>/i);
  if (!match) return fallbackName;
  const cleaned = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
  return cleaned || fallbackName;
}

export function matchTargetDocument<T extends { index: number; name: string; title: string }>(
  files: T[],
  docName: string
): T | undefined {
  if (!docName) return undefined;
  const cleanDocName = docName.trim().toLowerCase();
  if (!cleanDocName) return undefined;

  // 1. 인덱스 완전 일치 (숫자 입력 시)
  if (/^\d+$/.test(cleanDocName)) {
    const byIndex = files.find((f) => f.index === Number(cleanDocName));
    if (byIndex) return byIndex;
  }

  // 2. 파일명 완전 일치
  const byExactName = files.find((f) => (f.name || '').toLowerCase() === cleanDocName);
  if (byExactName) return byExactName;

  // 3. 문서명(제목) 완전 일치
  const byExactTitle = files.find((f) => (f.title || '').toLowerCase() === cleanDocName);
  if (byExactTitle) return byExactTitle;

  // 4. 문서명(제목) 부분 일치
  const byPartialTitle = files.find((f) => (f.title || '').toLowerCase().includes(cleanDocName));
  if (byPartialTitle) return byPartialTitle;

  // 5. 파일명 부분 일치
  return files.find((f) => (f.name || '').toLowerCase().includes(cleanDocName));
}

export async function fetchDartDocument(rceptNo: string, docName?: string): Promise<unknown> {
  const buffer = await dartQueue(async () => {
    const key = getDartApiKey();
    const url = `${DART_BASE_URL}/document.xml?crtfc_key=${key}&rcept_no=${rceptNo}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`DART 문서 다운로드 실패: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });

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
  const parsedFiles = zip.getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry, index) => {
      const ext = path.extname(entry.entryName).toLowerCase();
      const isText = TEXT_EXTS.has(ext);
      const rawText = isText ? decodeBuffer(entry.getData()) : '';
      const title = isText && ext === '.xml' ? extractDocTitle(rawText, entry.entryName) : entry.entryName;
      return {
        index,
        name: entry.entryName,
        title,
        size_kb: Math.round((entry.header.size / 1024) * 10) / 10,
        isText,
        rawText
      };
    });

  const directUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;

  // 1. 단일 파일 공시(수시공시: CB, 유증 등): docName 없이도 원문 즉시 100% 반환
  if (parsedFiles.length === 1 && (!docName || docName.trim() === '')) {
    const f = parsedFiles[0];
    const content = f.isText
      ? (path.extname(f.name).toLowerCase() === '.xml' ? cleanXmlContent(f.rawText) : f.rawText)
      : `[첨부 바이너리 파일: ${f.name} (${f.size_kb} KB) - 텍스트 추출 대상 아님]`;
    return {
      rcept_no: rceptNo,
      direct_url: directUrl,
      mode: 'single_document',
      title: f.title,
      file_name: f.name,
      size_kb: f.size_kb,
      content
    };
  }

  // 2. 다중 파일 공시(사업보고서 등)에서 docName이 없는 경우: 목차(TOC) 반환
  if (!docName || docName.trim() === '') {
    return {
      rcept_no: rceptNo,
      direct_url: directUrl,
      mode: 'toc',
      total_files: parsedFiles.length,
      notice: '본 공시는 여러 첨부문서로 구성되어 있어 목차(TOC)를 반환합니다. 특정 문서의 원문을 조회하려면 doc_name 파라미터에 문서명(예: "연결감사보고서") 또는 파일명을 지정하세요.',
      documents: parsedFiles.map((f) => ({
        index: f.index,
        title: f.title,
        name: f.name,
        size_kb: f.size_kb
      }))
    };
  }

  // 3. docName이 'all'인 경우: 전체 파일 내용 일괄 반환
  const cleanDocName = docName.trim().toLowerCase();
  if (cleanDocName === 'all') {
    return {
      rcept_no: rceptNo,
      direct_url: directUrl,
      mode: 'all',
      total_files: parsedFiles.length,
      files: parsedFiles.map((f) => ({
        index: f.index,
        title: f.title,
        name: f.name,
        size_kb: f.size_kb,
        content: f.isText
          ? (path.extname(f.name).toLowerCase() === '.xml' ? cleanXmlContent(f.rawText) : f.rawText)
          : `[첨부 바이너리 파일: ${f.name} (${f.size_kb} KB) - 텍스트 추출 대상 아님]`
      }))
    };
  }

  // 4. 특정 문서 타겟팅 (다단계 우선순위 매칭)
  const target = matchTargetDocument(parsedFiles, docName);

  if (!target) {
    const available = parsedFiles.map((f) => `[${f.index}] ${f.title} (${f.name})`).join(', ');
    throw new Error(`지정한 문서 '${docName}'를 찾을 수 없습니다. 사용 가능한 문서 목록: ${available}`);
  }

  const content = target.isText
    ? (path.extname(target.name).toLowerCase() === '.xml' ? cleanXmlContent(target.rawText) : target.rawText)
    : `[첨부 바이너리 파일: ${target.name} (${target.size_kb} KB) - 텍스트 추출 대상 아님]`;

  return {
    rcept_no: rceptNo,
    direct_url: directUrl,
    mode: 'targeted_document',
    title: target.title,
    file_name: target.name,
    size_kb: target.size_kb,
    content
  };
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
    const tmp = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
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

export function rankCorpMatches(items: CorpItem[], query: string, limit = 10): CorpItem[] {
  const q = query.trim();
  if (!q) return [];
  const qLower = q.toLowerCase();

  // 1. 종목코드 1~6자리 숫자 (앞자리 0 누락 보정 및 O(1) 색인 매칭)
  if (/^\d{1,6}$/.test(q)) {
    const padded = q.padStart(6, '0');
    const found = (items === corpCache ? stockIndex.get(padded) : undefined) || items.find((it) => it.stock_code === padded);
    if (found) return [found];
  }

  // 2. 고유번호 8자리 O(1)
  if (/^\d{8}$/.test(q)) {
    const found = (items === corpCache ? corpIndex.get(q) : undefined) || items.find((it) => it.corp_code === q);
    if (found) return [found];
  }

  // 3. 회사명 검색 및 가중치 랭킹 정렬
  // 1) 사명 완전 일치 -> 2) 상장사(stock_code !== '') -> 3) 접두사 일치 -> 4) 짧은 사명 우선
  const matches = items.filter((it) => (it.corp_name || '').toLowerCase().includes(qLower));

  matches.sort((a, b) => {
    const aName = (a.corp_name || '').toLowerCase();
    const bName = (b.corp_name || '').toLowerCase();

    // 1) 사명 완전 일치
    const aExact = aName === qLower;
    const bExact = bName === qLower;
    if (aExact !== bExact) return aExact ? -1 : 1;

    // 2) 상장사 우선 (stock_code 유무)
    const aListed = Boolean(a.stock_code && a.stock_code.trim());
    const bListed = Boolean(b.stock_code && b.stock_code.trim());
    if (aListed !== bListed) return aListed ? -1 : 1;

    // 3) 접두사 일치
    const aPrefix = aName.startsWith(qLower);
    const bPrefix = bName.startsWith(qLower);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;

    // 4) 이름 길이 짧은 순 (더 핵심적인 본사 매칭)
    const aLen = (a.corp_name || '').length;
    const bLen = (b.corp_name || '').length;
    if (aLen !== bLen) {
      return aLen - bLen;
    }

    return (a.corp_name || '').localeCompare(b.corp_name || '');
  });

  return matches.slice(0, Math.max(0, limit));
}

export async function searchCorpCode(query: string, limit = 10): Promise<CorpItem[]> {
  const items = await loadCorpList();
  return rankCorpMatches(items, query, limit);
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
    params: z.record(z.string(), z.unknown()).optional().default({}).describe('요청 파라미터 객체 (예: basDd: "20240315", isin: "KR7005930003", isuCd: "005930" 등)')
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

// [도구 3: DART 공시 원문 핀포인트 다운로드 (2단계 TOC / 특정 문서 타격)]
server.tool(
  'download_dart_document',
  'DART 공시 접수번호(14자리)의 공시 원문을 다운로드합니다. 단일 파일 공시(수시공시)는 원문 전체를 즉시 반환하며, 여러 파일로 구성된 정기보고서(사업/분기보고서)는 목차(TOC)를 먼저 반환합니다. 특정 문서(예: "연결감사보고서")를 지정하면 해당 주석 원문만 핀포인트로 가져옵니다. (스타일 노이즈 제거로 토큰 소모 40% 절감, 표/문장 원문 100% 무손실 보존)',
  {
    rcept_no: z.string().regex(/^\d{14}$/, '14자리 숫자 접수번호여야 합니다 (예: 20240312000784).'),
    doc_name: z.string().optional().describe('조회할 문서명(예: "연결감사보고서", "사업보고서"), 파일명, 또는 인덱스 번호. 생략 시 정기보고서는 목차(TOC)를 반환하고 단일 공시는 본문을 즉시 반환합니다. 전체를 다 받으려면 "all" 지정.')
  },
  async ({ rcept_no, doc_name }) => safeTool(() => fetchDartDocument(rcept_no, doc_name))
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

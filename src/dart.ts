/**
 * dart.ts - 금융감독원 Open DART 공식 API 클라이언트 & 기업 고유번호 검색
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

const DART_BASE_URL = 'https://opendart.fss.or.kr/api';
const CACHE_FILE = path.join(os.tmpdir(), 'krxdart_corp_codes.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// DART 호출 간격 제어 (초당 4회, 250ms)
let lastDartAt = 0;
async function throttleDart() {
  const wait = 250 - (Date.now() - lastDartAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastDartAt = Date.now();
}

function getDartApiKey(): string {
  const key = process.env.DART_API_KEY?.trim();
  if (!key) throw new Error('DART_API_KEY 환경변수가 설정되지 않았습니다. 금융감독원 오픈DART 키를 등록해주세요.');
  return key;
}

function decodeBuffer(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('euc-kr').decode(buffer);
  }
}

/**
 * 1. DART 오픈API 원본 호출 (/api/*.json)
 */
export async function fetchDart(endpoint: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const key = getDartApiKey();
  await throttleDart();

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
    throw new Error(`DART 응답이 JSON 형식이 아닙니다: ${text.slice(0, 300)}`);
  }

  if (json?.status && json.status !== '000') {
    if (json.status === '020') throw new Error('[DART 한도 초과] 일일 호출 한도(10,000회)를 초과했습니다.');
    if (json.status === '010' || json.status === '011') throw new Error('[DART 키 오류] 유효하지 않은 DART_API_KEY입니다.');
  }

  return json;
}

/**
 * 2. DART 공시보고서 원문 다운로드 (/api/document.xml)
 */
export async function fetchDartDocument(rceptNo: string): Promise<unknown> {
  const key = getDartApiKey();
  await throttleDart();

  const url = `${DART_BASE_URL}/document.xml?crtfc_key=${key}&rcept_no=${rceptNo}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`DART 문서 다운로드 실패: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());

  // DART는 에러 시 ZIP 대신 XML 에러 메시지 반환 (PK 헤더: 0x50, 0x4b)
  if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    const errorText = decodeBuffer(buffer);
    const msgMatch = errorText.match(/<message>([^<]*)<\/message>/);
    const statusMatch = errorText.match(/<status>([^<]*)<\/status>/);
    const errMsg = msgMatch ? msgMatch[1] : errorText.slice(0, 300);
    throw new Error(`[DART 문서 다운로드 실패 ${statusMatch?.[1] || 'ERROR'}] ${errMsg}`);
  }

  const zip = new AdmZip(buffer);
  const files = zip.getEntries().map((entry) => ({
    name: entry.entryName,
    size: entry.header.size,
    content: decodeBuffer(entry.getData())
  }));

  return {
    rcept_no: rceptNo,
    direct_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`,
    files
  };
}

/**
 * 3. 기업 고유번호 / 종목코드 O(1) 인메모리 인덱스 검색
 */
export interface CorpItem {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  modify_date: string;
}

let corpCodeCache: CorpItem[] | null = null;
let corpCodeLoadPromise: Promise<CorpItem[]> | null = null;
const stockCodeIndex = new Map<string, CorpItem>();
const corpCodeIndex = new Map<string, CorpItem>();

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
    // 디스크 캐시 확인
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
    } catch {}

    // DART 원본 다운로드
    const key = getDartApiKey();
    await throttleDart();
    const res = await fetch(`${DART_BASE_URL}/corpCode.xml?crtfc_key=${key}`, {
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`고유번호 파일 다운로드 실패: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      const errorText = decodeBuffer(buffer);
      const msgMatch = errorText.match(/<message>([^<]*)<\/message>/);
      throw new Error(`[DART 기업목록 다운로드 실패] ${msgMatch ? msgMatch[1] : errorText.slice(0, 300)}`);
    }

    const zip = new AdmZip(buffer);
    const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.xml'));
    if (!xmlEntry) throw new Error('고유번호 ZIP 파일 내 XML 파일이 없습니다.');

    const xmlText = xmlEntry.getData().toString('utf-8');
    const items: CorpItem[] = [];
    const REGEX_LIST = /<list>([\s\S]*?)<\/list>/g;
    let match;

    while ((match = REGEX_LIST.exec(xmlText)) !== null) {
      const b = match[1];
      items.push({
        corp_code: b.match(/<corp_code>([^<]*?)<\/corp_code>/)?.[1]?.trim() || '',
        corp_name: b.match(/<corp_name>([^<]*?)<\/corp_name>/)?.[1]?.trim() || '',
        stock_code: b.match(/<stock_code>([^<]*?)<\/stock_code>/)?.[1]?.trim() || '',
        modify_date: b.match(/<modify_date>([^<]*?)<\/modify_date>/)?.[1]?.trim() || ''
      });
    }

    corpCodeCache = items;
    buildIndexes(items);

    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(items), 'utf-8');
    } catch {}

    return items;
  })().finally(() => {
    corpCodeLoadPromise = null;
  });

  return corpCodeLoadPromise;
}

export async function searchCorpCode(query: string, limit: number = 10): Promise<CorpItem[]> {
  const list = await loadCorpCodeList();
  const q = query.trim().toLowerCase();

  // 1. 종목코드 6자리 O(1) 매칭
  if (/^\d{6}$/.test(q) && stockCodeIndex.has(q)) {
    return [stockCodeIndex.get(q)!];
  }
  // 2. 고유번호 8자리 O(1) 매칭
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
}

#!/usr/bin/env node
/**
 * krxdart-mcp: Pure Open DART Disclosures & KRX Market Data MCP Server
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchKrx, KRX_CATEGORY_MAP } from './krx.js';
import { fetchDart, fetchDartDocument, searchCorpCode } from './dart.js';

const server = new McpServer({
  name: 'krxdart-mcp',
  version: '2.1.0'
});

async function safeTool(action: () => Promise<unknown>) {
  try {
    const data = await action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text' as const, text: `오류 발생: ${message}` }] };
  }
}

// [1. KRX 한국거래소 공식 오픈API 호출 (31개 시장 전면 지원)]
server.tool(
  'call_krx_api',
  '한국거래소(KRX) 공식 오픈API(openapi.krx.co.kr)를 호출하여 31개 전 시장(주식, ETF, 지수, 채권, 선물, 옵션, 금, 석유, 배출권, ESG 등)의 원본 JSON을 반환합니다. (KRX_API_KEY는 서버에서 자동 주입)',
  {
    api_id: z.string().trim().min(1).describe('KRX 공식 API ID (31개 지원: stk_bydd_trd[주식매매], ksq_bydd_trd[코스닥], etf_bydd_trd[ETF], krx_dd_trd[KRX지수], kts_bydd_trd[국채], fut_bydd_trd[선물], opt_bydd_trd[옵션], gold_bydd_trd[금], oil_bydd_trd[석유] 등)'),
    params: z.record(z.unknown()).optional().default({}).describe('요청 조건 파라미터 (예: basDd: "20260912", isin: "KR7005930003" 등)')
  },
  async ({ api_id, params }) => safeTool(() => fetchKrx(api_id, params))
);

// [2. DART 오픈API 원본 호출 (70여 개 공식 엔드포인트 지원)]
server.tool(
  'call_dart_api',
  '금융감독원 Open DART의 모든 공식 엔드포인트를 호출하여 원본 JSON을 반환합니다. (DART_API_KEY는 서버에서 자동 주입)',
  {
    endpoint: z.string().regex(/^\/?[a-zA-Z0-9_-]+\.json$/, '올바른 DART JSON 엔드포인트여야 합니다 (예: "/company.json", "company.json", "/list.json")'),
    params: z.record(z.unknown()).optional().default({}).describe('DART 요청 파라미터 객체 (예: corp_code, bsns_year, reprt_code 등)')
  },
  async ({ endpoint, params }) => safeTool(() => fetchDart(endpoint, params))
);

// [3. DART 공시보고서 원문 다운로드]
server.tool(
  'download_dart_document',
  'DART 공시 접수번호(14자리)의 법정 공시서류(ZIP)를 내려받아 내부 파일 목록과 디코딩된 텍스트 본문을 반환합니다.',
  {
    rcept_no: z.string().regex(/^\d{14}$/, 'DART 접수번호는 14자리 숫자여야 합니다')
  },
  async ({ rcept_no }) => safeTool(() => fetchDartDocument(rcept_no))
);

// [4. 회사 고유번호 / 종목코드 검색]
server.tool(
  'search_corp_code',
  '회사명, 6자리 종목코드, 또는 8자리 고유번호로 기업을 검색합니다. (O(1) 캐시 검색)',
  {
    query: z.string().trim().min(1, '검색어를 입력해주세요').describe('회사명(예: "삼성전자"), 6자리 종목코드("005930"), 또는 8자리 고유번호'),
    limit: z.number().int().min(1).max(50).default(10).describe('반환할 최대 결과 수')
  },
  async ({ query, limit }) => safeTool(() => searchCorpCode(query, limit))
);

export { KRX_CATEGORY_MAP };

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('krxdart-mcp 치명적 오류:', error);
  process.exit(1);
});

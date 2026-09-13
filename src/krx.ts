/**
 * krx.ts - 한국거래소(KRX) 공식 31개 오픈API 클라이언트
 */

const KRX_BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis';

// 한국거래소 공식 31개 API ID 및 카테고리 경로 매핑
export const KRX_CATEGORY_MAP: Record<string, string> = {
  // 1. 주식 (sto) - 8개
  stk_bydd_trd: 'sto',       // 유가증권 일별매매정보
  ksq_bydd_trd: 'sto',       // 코스닥 일별매매정보
  knx_bydd_trd: 'sto',       // 코넥스 일별매매정보
  sw_bydd_trd: 'sto',        // 신주인수권증권 일별매매정보
  sr_bydd_trd: 'sto',        // 신주인수권증서 일별매매정보
  stk_isu_base_info: 'sto',   // 유가증권 종목기본정보
  ksq_isu_base_info: 'sto',   // 코스닥 종목기본정보
  knx_isu_base_info: 'sto',   // 코넥스 종목기본정보

  // 2. 증권상품 (etp) - 3개
  etf_bydd_trd: 'etp',       // ETF 일별매매정보
  etn_bydd_trd: 'etp',       // ETN 일별매매정보
  elw_bydd_trd: 'etp',       // ELW 일별매매정보

  // 3. 지수 (idx) - 5개
  krx_dd_trd: 'idx',         // KRX 시리즈 일별시세정보
  kospi_dd_trd: 'idx',       // KOSPI 시리즈 일별시세정보
  kosdaq_dd_trd: 'idx',      // KOSDAQ 시리즈 일별시세정보
  bon_dd_trd: 'idx',         // 채권지수 시세정보
  drvprod_dd_trd: 'idx',     // 파생상품지수 시세정보

  // 4. 채권 (bon) - 3개
  kts_bydd_trd: 'bon',       // 국채전문유통시장 일별매매정보
  bnd_bydd_trd: 'bon',       // 일반채권시장 일별매매정보
  smb_bydd_trd: 'bon',       // 소액채권시장 일별매매정보

  // 5. 파생상품 (drv) - 6개
  fut_bydd_trd: 'drv',       // 선물 일별매매 (주식선물外)
  eqsfu_stk_bydd_trd: 'drv', // 주식선물(유가) 일별매매
  eqkfu_ksq_bydd_trd: 'drv', // 주식선물(코스닥) 일별매매
  opt_bydd_trd: 'drv',       // 옵션 일별매매 (주식옵션外)
  eqsop_bydd_trd: 'drv',     // 주식옵션(유가) 일별매매
  eqkop_bydd_trd: 'drv',     // 주식옵션(코스닥) 일별매매

  // 6. 일반상품 (gen) - 3개
  oil_bydd_trd: 'gen',       // 석유시장 일별매매정보
  gold_bydd_trd: 'gen',      // 금시장 일별매매정보
  ets_bydd_trd: 'gen',       // 배출권 시장 일별매매정보

  // 7. ESG (esg) - 3개
  sri_bond_info: 'esg',      // 사회책임투자채권 정보
  esg_index_info: 'esg',     // ESG 지수
  esg_etp_info: 'esg'        // ESG 증권상품
};

// KRX 호출 간격 제어 (초당 10회, 100ms)
let lastKrxAt = 0;
async function throttleKrx() {
  const wait = 100 - (Date.now() - lastKrxAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastKrxAt = Date.now();
}

function getKrxApiKey(): string {
  const key = process.env.KRX_API_KEY?.trim();
  if (!key) throw new Error('KRX_API_KEY 환경변수가 설정되지 않았습니다. 한국거래소(openapi.krx.co.kr) 발급 인증키를 등록해주세요.');
  return key;
}

export async function fetchKrx(apiId: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const apiKey = getKrxApiKey();
  await throttleKrx();

  let cleanId = apiId.trim();
  let category = KRX_CATEGORY_MAP[cleanId];

  if (cleanId.includes('/')) {
    const parts = cleanId.split('/').filter(Boolean);
    if (parts.length === 2) {
      category = parts[0];
      cleanId = parts[1];
    }
  }

  if (!category) {
    const sampleIds = Object.keys(KRX_CATEGORY_MAP).slice(0, 5).join(', ');
    throw new Error(`[KRX 오류] 알 수 없는 API ID: "${apiId}". 31개 공식 ID(예: ${sampleIds} 등)를 사용해주세요.`);
  }

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') {
      searchParams.set(k, String(v));
    }
  }

  const qs = searchParams.toString();
  const url = `${KRX_BASE_URL}/${category}/${cleanId}${qs ? `?${qs}` : ''}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'AUTH_KEY': apiKey,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[KRX HTTP ${res.status} ${res.statusText}] ${text.slice(0, 300).trim()}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KRX 응답이 JSON 형식이 아닙니다: ${text.slice(0, 300).trim()}`);
  }

  if (json?.error || json?.error_code || json?.result?._error_code) {
    const code = json?.error_code || json?.result?._error_code || '오류';
    const msg = json?.error_message || json?.result?._error_message || json?.error || '알 수 없는 거래소 오류';
    throw new Error(`[KRX API 오류 ${code}] ${msg}`);
  }

  return json;
}

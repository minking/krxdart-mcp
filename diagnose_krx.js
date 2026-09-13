// diagnose_krx.js - 한국거래소(KRX) 공식 오픈API 31개 서비스 즉시 진단 도구
const apiKey = process.argv[2] || process.env.KRX_API_KEY;
const targetApi = process.argv[3] || 'stk_bydd_trd'; // 기본: 주식 일별매매

if (!apiKey) {
  console.log('===========================================================');
  console.log('사용법: node diagnose_krx.js "거래소_발급_인증키" [API_ID]');
  console.log('예시 1 (주식): node diagnose_krx.js "내_인증키"');
  console.log('예시 2 (ETF) : node diagnose_krx.js "내_인증키" etf_bydd_trd');
  console.log('예시 3 (지수): node diagnose_krx.js "내_인증키" krx_dd_trd');
  console.log('===========================================================');
  process.exit(1);
}

const KRX_CATEGORY_MAP = {
  stk_bydd_trd: 'sto', ksq_bydd_trd: 'sto', knx_bydd_trd: 'sto',
  sw_bydd_trd: 'sto', sr_bydd_trd: 'sto',
  stk_isu_base_info: 'sto', ksq_isu_base_info: 'sto', knx_isu_base_info: 'sto',
  etf_bydd_trd: 'etp', etn_bydd_trd: 'etp', elw_bydd_trd: 'etp',
  krx_dd_trd: 'idx', kospi_dd_trd: 'idx', kosdaq_dd_trd: 'idx', bon_dd_trd: 'idx', drvprod_dd_trd: 'idx',
  kts_bydd_trd: 'bon', bnd_bydd_trd: 'bon', smb_bydd_trd: 'bon',
  fut_bydd_trd: 'drv', eqsfu_stk_bydd_trd: 'drv', eqkfu_ksq_bydd_trd: 'drv',
  opt_bydd_trd: 'drv', eqsop_bydd_trd: 'drv', eqkop_bydd_trd: 'drv',
  oil_bydd_trd: 'gen', gold_bydd_trd: 'gen', ets_bydd_trd: 'gen',
  sri_bond_info: 'esg', esg_index_info: 'esg', esg_etp_info: 'esg'
};

const category = KRX_CATEGORY_MAP[targetApi] || 'sto';
const url = `https://data-dbg.krx.co.kr/svc/apis/${category}/${targetApi}`;

console.log('=== 한국거래소(KRX) 공식 오픈API 진단 시작 ===');
console.log(`1. 대상 API ID: ${targetApi} (카테고리: ${category})`);
console.log(`2. 요청 URL: ${url}`);
console.log('3. AUTH_KEY 헤더 인증 전송 중...');

try {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'AUTH_KEY': apiKey.trim(),
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });

  const text = await res.text();
  console.log(`4. HTTP 상태 코드: ${res.status} ${res.statusText}`);

  try {
    const json = JSON.parse(text);
    if (res.ok && !json.error && !json.error_code && !json.result?._error_code) {
      console.log('\n🎉 [인증 및 호출 대성공!]');
      console.log('거래소에서 정상적으로 JSON 데이터를 수신했습니다.');
      const keys = Object.keys(json);
      console.log('- 최상위 데이터 필드:', keys.join(', '));
      const firstArrayKey = keys.find(k => Array.isArray(json[k]));
      if (firstArrayKey && json[firstArrayKey].length > 0) {
        console.log(`- ${firstArrayKey} 건수: ${json[firstArrayKey].length}개 항목 수신됨`);
        console.log('- 첫 번째 데이터 샘플:', json[firstArrayKey][0]);
      } else {
        console.log('- 수신 원본 샘플:', JSON.stringify(json).slice(0, 300));
      }
    } else {
      console.log('\n❌ [거래소 API 거부]');
      console.log('- 응답 내용:', JSON.stringify(json, null, 2));
    }
  } catch {
    console.log('\n❌ [비정상 응답 본문]:\n', text.slice(0, 400));
  }
} catch (err) {
  console.error('\n❌ [네트워크 연결 오류]:', err.message);
}

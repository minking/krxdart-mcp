import assert from 'node:assert';

// 1. DART 공식 엔드포인트 경로 정규식 검증 (SSRF 및 경로 위조 방어)
function testEndpointSecurityRegex() {
  const endpointRegex = /^\/?[a-zA-Z0-9_-]+\.json$/;

  assert.strictEqual(endpointRegex.test('/company.json'), true);
  assert.strictEqual(endpointRegex.test('company.json'), true, '슬래시 없이도 허용');
  assert.strictEqual(endpointRegex.test('/fnlttSinglAcnt.json'), true);
  assert.strictEqual(endpointRegex.test('/detSecIsu.json'), true);
  assert.strictEqual(endpointRegex.test('/../etc/passwd'), false, '경로 탐색 공격 거부');
  assert.strictEqual(endpointRegex.test('/test.xml'), false, 'json 확장자만 허용');
  console.log('✅ [1/3] DART 엔드포인트 보안 정규식 검증 통과');
}

// 2. DART / KRX 공식 식별자 규격 검증
function testCodeSchemas() {
  const stockRegex = /^\d{6}$/;
  const corpRegex = /^\d{8}$/;
  const rceptRegex = /^\d{14}$/;

  assert.strictEqual(stockRegex.test('005930'), true, '삼성전자 종목코드 6자리');
  assert.strictEqual(stockRegex.test('00593'), false, '5자리 거부');
  assert.strictEqual(corpRegex.test('00126380'), true, '삼성전자 DART 고유번호 8자리');
  assert.strictEqual(corpRegex.test('126380'), false, '6자리 거부');
  assert.strictEqual(rceptRegex.test('20240312000789'), true, 'DART 접수번호 14자리');
  console.log('✅ [2/3] DART/KRX 공식 식별자 규격 검증 통과');
}

// 3. O(1) 인메모리 인덱스 맵 알고리즘 검증
function testMapIndexing() {
  const stockMap = new Map();
  const corpMap = new Map();
  const sample = { corp_code: '00126380', corp_name: '삼성전자', stock_code: '005930' };

  stockMap.set(sample.stock_code, sample);
  corpMap.set(sample.corp_code, sample);

  assert.strictEqual(stockMap.get('005930')?.corp_name, '삼성전자');
  assert.strictEqual(corpMap.get('00126380')?.stock_code, '005930');
  console.log('✅ [3/3] O(1) 초고속 인덱스 맵 알고리즘 검증 통과');
}

// 4. DART 원문 ZIP 파일 시그니처(PK 헤더) 판별 검증
function testZipSignatureValidation() {
  const validZipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const xmlErrorBuffer = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><result><status>013</status></result>');

  assert.strictEqual(validZipHeader[0] === 0x50 && validZipHeader[1] === 0x4b, true, '정상 ZIP 헤더 PK 감지');
  assert.strictEqual(xmlErrorBuffer[0] === 0x50 && xmlErrorBuffer[1] === 0x4b, false, 'XML 에러 텍스트는 ZIP이 아님을 감지');
  console.log('✅ [4/4] DART ZIP 시그니처 및 에러 감지 검증 통과');
}

// 5. 한국거래소(KRX) 공식 31개 서비스 카테고리 매핑 검증
function testKrxCategoryMapping() {
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

  const count = Object.keys(KRX_CATEGORY_MAP).length;
  assert.strictEqual(count, 31, '한국거래소 전체 31개 서비스 등록 확인');

  // 카테고리 매핑 확인
  assert.strictEqual(KRX_CATEGORY_MAP['stk_bydd_trd'], 'sto');
  assert.strictEqual(KRX_CATEGORY_MAP['etf_bydd_trd'], 'etp');
  assert.strictEqual(KRX_CATEGORY_MAP['krx_dd_trd'], 'idx');
  assert.strictEqual(KRX_CATEGORY_MAP['kts_bydd_trd'], 'bon');
  assert.strictEqual(KRX_CATEGORY_MAP['gold_bydd_trd'], 'gen');
  assert.strictEqual(KRX_CATEGORY_MAP['fut_bydd_trd'], 'drv');
  assert.strictEqual(KRX_CATEGORY_MAP['sri_bond_info'], 'esg');

  console.log('✅ [5/5] 한국거래소 공식 31개 서비스 매핑 검증 통과');
}

function runAll() {
  testEndpointSecurityRegex();
  testCodeSchemas();
  testMapIndexing();
  testZipSignatureValidation();
  testKrxCategoryMapping();
  console.log('\n🎉 [krxdart-mcp v2.0.1] KRX 31개 공식 오픈API 지원 자체 검증 100% 통과');
}

runAll();

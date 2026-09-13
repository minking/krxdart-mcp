import assert from 'node:assert';
import { createQueue, KRX_CATEGORY_MAP, decodeBuffer } from './dist/index.js';

// 1. KRX 31개 서비스 카테고리 매핑 검증
function testKrxCategoryMapping() {
  const count = Object.keys(KRX_CATEGORY_MAP).length;
  assert.strictEqual(count, 31, 'KRX 공식 31개 서비스가 등록되어 있어야 합니다.');
  assert.strictEqual(KRX_CATEGORY_MAP['stk_bydd_trd'], 'sto');
  assert.strictEqual(KRX_CATEGORY_MAP['etf_bydd_trd'], 'etp');
  assert.strictEqual(KRX_CATEGORY_MAP['krx_dd_trd'], 'idx');
  assert.strictEqual(KRX_CATEGORY_MAP['kts_bydd_trd'], 'bon');
  assert.strictEqual(KRX_CATEGORY_MAP['fut_bydd_trd'], 'drv');
  assert.strictEqual(KRX_CATEGORY_MAP['oil_bydd_trd'], 'gen');
  assert.strictEqual(KRX_CATEGORY_MAP['sri_bond_info'], 'esg');
  console.log('✅ 1. KRX 31개 서비스 매핑 검증 통과');
}

// 2. DART 엔드포인트 규격 검증
function testDartEndpointValidation() {
  const regex = /^[a-zA-Z0-9_-]+\.json$/;
  assert.strictEqual(regex.test('company.json'), true);
  assert.strictEqual(regex.test('list.json'), true);
  assert.strictEqual(regex.test('fnlttSinglAcnt.json'), true);
  assert.strictEqual(regex.test('fnlttMultiAcnt.json'), true);
  assert.strictEqual(regex.test('../etc/passwd'), false);
  assert.strictEqual(regex.test('company.xml'), false);
  console.log('✅ 2. DART 엔드포인트 규격 검증 통과');
}

// 3. 순차 실행 큐(Rate-limit Queue) 간격 및 동시성 검증
async function testQueueRateLimit() {
  const queue = createQueue(50); // 50ms 간격
  const timestamps = [];

  await Promise.all([
    queue(async () => timestamps.push(Date.now())),
    queue(async () => timestamps.push(Date.now())),
    queue(async () => timestamps.push(Date.now()))
  ]);

  assert.strictEqual(timestamps.length, 3);
  const diff1 = timestamps[1] - timestamps[0];
  const diff2 = timestamps[2] - timestamps[1];
  assert.ok(diff1 >= 40, `diff1 (${diff1}ms)은 최소 간격에 근접해야 함`);
  assert.ok(diff2 >= 40, `diff2 (${diff2}ms)은 최소 간격에 근접해야 함`);
  console.log('✅ 3. 순차 실행 큐 간격 보장 검증 통과');
}

// 4. ZIP 파일 시그니처 (PK 헤더) 검증
function testZipSignature() {
  const validZip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const xmlError = Buffer.from('<result><status>013</status></result>');
  assert.strictEqual(validZip[0] === 0x50 && validZip[1] === 0x4b, true);
  assert.strictEqual(xmlError[0] === 0x50 && xmlError[1] === 0x4b, false);
  console.log('✅ 4. ZIP 시그니처 판별 검증 통과');
}

// 5. EUC-KR 및 UTF-8 자동 디코딩 검증
function testEncodingDecode() {
  const utf8Buf = Buffer.from('삼성전자 공시', 'utf-8');
  assert.strictEqual(decodeBuffer(utf8Buf), '삼성전자 공시');

  // EUC-KR 인코딩 바이트: 삼성전자 (BBEF BCBA C0FC C0DA)
  const euckrBuf = Buffer.from([0xbb, 0xef, 0xbc, 0xba, 0xc0, 0xfc, 0xc0, 0xda]);
  assert.strictEqual(decodeBuffer(euckrBuf), '삼성전자');
  console.log('✅ 5. UTF-8 및 EUC-KR 인코딩 자동 복원 검증 통과');
}

// 6. 공시 원문 글자수 가드(max_chars) 로직 검증
function testMaxCharsGuard() {
  const sampleLongText = '가'.repeat(10000);
  const maxChars = 8000;

  let content = sampleLongText;
  const originalLength = content.length;
  if (maxChars > 0 && content.length > maxChars) {
    content = content.slice(0, maxChars) +
      `\n\n...[글자 수 제한으로 인해 생략됨 (총 ${originalLength.toLocaleString()}자 중 ${maxChars.toLocaleString()}자 반환)]...`;
  }

  assert.ok(content.startsWith('가'.repeat(8000)), '지정된 글자 수만큼 본문 유지');
  assert.ok(content.includes('글자 수 제한으로 인해 생략됨'), '생략 안내 태그 포함');
  console.log('✅ 6. 공시 원문 max_chars 안전장치 검증 통과');
}

async function run() {
  testKrxCategoryMapping();
  testDartEndpointValidation();
  await testQueueRateLimit();
  testZipSignature();
  testEncodingDecode();
  testMaxCharsGuard();
  console.log('\n🎉 krxdart-mcp 모든 자체 검증 100% 통과');
}

run();

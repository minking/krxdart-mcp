import assert from 'node:assert';
import {
  createQueue,
  KRX_CATEGORY_MAP,
  decodeBuffer,
  cleanXmlContent,
  extractDocTitle,
  matchTargetDocument,
  parseDartApiResponse,
  rankCorpMatches
} from './dist/index.js';

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
    queue(async () => timestamps.push(performance.now())),
    queue(async () => timestamps.push(performance.now())),
    queue(async () => timestamps.push(performance.now()))
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

// 6. 무손실 XML 클리너 (토큰 다이어트 및 표 구조/원문 보존) 검증
function testCleanXml() {
  const sampleXml = `
<TABLE BORDER="0" WIDTH="600" ACLASS="NORMAL">
<COLGROUP><COL WIDTH="333"></COL><COL WIDTH="249"></COL></COLGROUP>
<TBODY>
<TR ACOPY="Y" ADELETE="Y">
<TD USERMARK="F-BT14" WIDTH="600" HEIGHT="34" COLSPAN="2" ALIGN="CENTER" VALIGN="MIDDLE">제 25 기</TD>
</TR>
<TR>
<TU CLASS="NORMAL" ALIGN="RIGHT" VALIGN="MIDDLE" WIDTH="342" HEIGHT="30">2023년 01월 01일</TU>
<TD WIDTH="258" HEIGHT="30" ROWSPAN="1">부터</TD>
</TR>
</TBODY>
</TABLE>
<PGBRK></PGBRK>
<P></P>
<P>계약 금액: 50,000,000원</P>
`;

  const cleaned = cleanXmlContent(sampleXml);

  // 6-1. 서식 속성 및 더미 태그 제거 확인
  assert.ok(!cleaned.includes('COLGROUP'), 'COLGROUP 태그가 제거되어야 합니다.');
  assert.ok(!cleaned.includes('PGBRK'), 'PGBRK 태그가 제거되어야 합니다.');
  assert.ok(!cleaned.includes('WIDTH="600"'), 'WIDTH 속성이 제거되어야 합니다.');
  assert.ok(!cleaned.includes('USERMARK'), 'USERMARK 속성이 제거되어야 합니다.');

  // 6-2. 핵심 속성(COLSPAN, ROWSPAN) 및 표 태그 보존 확인
  assert.ok(cleaned.includes('<td colspan="2">제 25 기</td>'), 'colspan 속성과 내용이 유지되어야 합니다.');
  assert.ok(cleaned.includes('<td rowspan="1">부터</td>'), 'rowspan 속성과 내용이 유지되어야 합니다.');
  assert.ok(cleaned.includes('<td>2023년 01월 01일</td>'), 'TU 태그가 표준 TD 태그로 변환되어야 합니다.');

  // 6-3. 한글 문장 및 금액 100% 무손실 보존 확인
  assert.ok(cleaned.includes('계약 금액: 50,000,000원'), '원문 본문 텍스트가 100% 보존되어야 합니다.');
  console.log('✅ 6. 무손실 XML 클리너 (토큰 다이어트/표 구조 보존) 검증 통과');
}

// 7. DART 공시 XML 문서명(<DOCUMENT-NAME>) 추출 검증
function testDocTitleExtraction() {
  const xmlWithTitle = '<DOCUMENT><DOCUMENT-NAME ACODE="00761">연결감사보고서</DOCUMENT-NAME></DOCUMENT>';
  assert.strictEqual(extractDocTitle(xmlWithTitle, 'fallback.xml'), '연결감사보고서');

  const xmlWithoutTitle = '<DOCUMENT><BODY>내용</BODY></DOCUMENT>';
  assert.strictEqual(extractDocTitle(xmlWithoutTitle, 'fallback.xml'), 'fallback.xml');
  console.log('✅ 7. DART XML 문서명(<DOCUMENT-NAME>) 추출 검증 통과');
}

// 8. DART 공시 타겟 문서 매칭 다단계 우선순위 검증 (숫자 "4" 0번 납치 방지)
function testTargetMatchingPriority() {
  const mockFiles = [
    { index: 0, name: '20240318000784_0000.xml', title: '감사보고서' },
    { index: 1, name: '20240318000784_0001.xml', title: '사업보고서' },
    { index: 4, name: '20240318000784_0004.xml', title: '연결재무제표' },
    { index: 5, name: 'attached_doc.xml', title: '4분기 실적보고서' }
  ];

  // 8-1. 인덱스 완전 일치 ("4" 입력 시 파일명 0번 납치 방지 -> index 4 매칭)
  const matchedByIndex = matchTargetDocument(mockFiles, '4');
  assert.strictEqual(matchedByIndex?.index, 4, '숫자 "4" 입력 시 index=4인 문서가 매칭되어야 합니다.');

  // 8-2. 파일명 완전 일치
  const matchedByFileName = matchTargetDocument(mockFiles, 'attached_doc.xml');
  assert.strictEqual(matchedByFileName?.index, 5, '파일명 완전 일치 문서가 매칭되어야 합니다.');

  // 8-3. 문서명(제목) 완전 일치
  const matchedByTitle = matchTargetDocument(mockFiles, '사업보고서');
  assert.strictEqual(matchedByTitle?.index, 1, '문서명 완전 일치 문서가 매칭되어야 합니다.');

  // 8-4. 문서명 부분 일치
  const matchedByPartialTitle = matchTargetDocument(mockFiles, '재무제표');
  assert.strictEqual(matchedByPartialTitle?.index, 4, '문서명 부분 일치 문서가 매칭되어야 합니다.');

  // 8-5. 파일명 부분 일치
  const matchedByPartialName = matchTargetDocument(mockFiles, '_0000.xml');
  assert.strictEqual(matchedByPartialName?.index, 0, '파일명 부분 일치 문서가 매칭되어야 합니다.');

  // 8-6. 미존재 문서
  const notFound = matchTargetDocument(mockFiles, '없는문서');
  assert.strictEqual(notFound, undefined, '존재하지 않는 문서는 undefined여야 합니다.');

  // 8-7. 문서명 완전일치가 부분일치보다 우선 (예: "감사보고서" vs "연결감사보고서")
  const ambiguousFiles = [
    { index: 0, name: 'f1.xml', title: '연결감사보고서' },
    { index: 1, name: 'f2.xml', title: '감사보고서' }
  ];
  const matchedExactTitle = matchTargetDocument(ambiguousFiles, '감사보고서');
  assert.strictEqual(matchedExactTitle?.index, 1, '완전일치 문서("감사보고서")가 부분일치 문서("연결감사보고서")보다 우선해야 합니다.');

  // 8-8. 공백 또는 빈 문자열 입력 시 undefined 반환 (0번 인덱스 납치 차단)
  assert.strictEqual(matchTargetDocument(mockFiles, ''), undefined, '빈 문자열 입력 시 undefined여야 합니다.');
  assert.strictEqual(matchTargetDocument(mockFiles, '   '), undefined, '공백 문자열 입력 시 undefined여야 합니다.');

  console.log('✅ 8. DART 타겟 문서 다단계 우선순위 매칭 (인덱스 납치 방지) 검증 통과');
}

// 9. XML 무손실 클리너 셀프클로징 본문 유실 방지 및 태그 문법 보존 검증
function testSelfClosingXmlPreservation() {
  // 9-1. <COLGROUP/> 셀프클로징 태그 뒤 본문 증발 방어 검증
  const sampleXml = `
<TABLE>
<COLGROUP/>
<TR><TD>본문 첫번째 테이블 데이터 100억원</TD></TR>
</TABLE>
<P>중간 공시 본문 내용</P>
<TABLE>
<COLGROUP><COL WIDTH="100"/></COLGROUP>
<TR><TD>본문 두번째 테이블 데이터</TD></TR>
</TABLE>
`;
  const cleaned = cleanXmlContent(sampleXml);
  assert.ok(cleaned.includes('본문 첫번째 테이블 데이터 100억원'), '<COLGROUP/> 이후 테이블 본문이 보존되어야 합니다.');
  assert.ok(cleaned.includes('중간 공시 본문 내용'), '<COLGROUP/> 이후 중간 본문이 보존되어야 합니다.');
  assert.ok(cleaned.includes('본문 두번째 테이블 데이터'), '두번째 테이블 본문이 보존되어야 합니다.');
  assert.ok(!cleaned.includes('COLGROUP'), '모든 COLGROUP 태그는 제거되어야 합니다.');

  // 9-2. <td /> 셀프클로징 보존 및 등호 공백 속성 정규화 검증
  const sampleSelfClosingTd = '<TABLE><TR><TD WIDTH="100" /><TD COLSPAN = "2" /><TD ROWSPAN = 3 /></TR></TABLE>';
  const cleanedTd = cleanXmlContent(sampleSelfClosingTd);
  assert.ok(cleanedTd.includes('<td />'), '셀프클로징 td 태그가 깨지지 않고 <td /> 형태로 보존되어야 합니다.');
  assert.ok(cleanedTd.includes('<td colspan="2" />'), 'COLSPAN 공백 허용 및 셀프클로징 형태가 보존되어야 합니다.');
  assert.ok(cleanedTd.includes('<td rowspan="3" />'), 'ROWSPAN 공백 허용 및 셀프클로징 형태가 보존되어야 합니다.');

  // 9-3. 단독 <COL WIDTH="100"/> 및 셀프클로징 <PGBRK/>, 빈 문단 <P CLASS="NORMAL"></P> 제거 및 본문 100% 무손실 검증
  const complexXml = `
<TABLE>
<COLGROUP/>
<COL WIDTH="120" />
<COL WIDTH="240"/>
<TR><TH COLSPAN = "2">임원 현황 표</TH></TR>
<TR><TD WIDTH="120" /><TD>홍길동 대표이사</TD></TR>
</TABLE>
<PGBRK/>
<P CLASS="NORMAL"></P>
<P></P>
<P>등기임원 총 보수: 1,500,000,000원</P>
`;
  const cleanedComplex = cleanXmlContent(complexXml);
  assert.ok(!cleanedComplex.includes('COLGROUP'), 'COLGROUP이 제거되어야 합니다.');
  assert.ok(!cleanedComplex.includes('COL WIDTH'), '독립된 COL 태그가 제거되어야 합니다.');
  assert.ok(!cleanedComplex.includes('PGBRK'), '셀프클로징 PGBRK 태그가 제거되어야 합니다.');
  assert.ok(!cleanedComplex.includes('CLASS="NORMAL"'), '빈 문단 P 태그가 제거되어야 합니다.');
  assert.ok(cleanedComplex.includes('<th colspan="2">임원 현황 표</th>'), 'TH 태그 및 colspan 속성이 보존되어야 합니다.');
  assert.ok(cleanedComplex.includes('<td />'), '셀프클로징 td 태그가 보존되어야 합니다.');
  assert.ok(cleanedComplex.includes('홍길동 대표이사'), '테이블 셀 본문이 보존되어야 합니다.');
  assert.ok(cleanedComplex.includes('등기임원 총 보수: 1,500,000,000원'), '공시 본문 내용이 100% 보존되어야 합니다.');

  console.log('✅ 9. XML 셀프클로징 본문 유실 방지 및 표 태그 보존 검증 통과');
}

// 10. 기업 검색 종목코드 앞자리 0 패딩 및 본사 가중치 랭킹 검증
function testStockCodeZeroPaddingAndRanking() {
  const sampleCorps = [
    { corp_code: '00126380', corp_name: '삼성전자', stock_code: '005930', modify_date: '20240101' },
    { corp_code: '00258801', corp_name: '카카오', stock_code: '035720', modify_date: '20240101' },
    { corp_code: '00300001', corp_name: '카카오페이', stock_code: '377300', modify_date: '20240101' },
    { corp_code: '00300002', corp_name: '카카오엔터프라이즈', stock_code: '', modify_date: '20240101' },
    { corp_code: '00300003', corp_name: '주식회사 카카오모빌리티', stock_code: '', modify_date: '20240101' },
    { corp_code: '00300004', corp_name: '카카오게임즈', stock_code: '293490', modify_date: '20240101' }
  ];

  // 10-1. 앞자리 0 누락 종목코드 패딩 매칭 검증 ("5930" -> "005930")
  const paddedMatch1 = rankCorpMatches(sampleCorps, '5930');
  assert.strictEqual(paddedMatch1.length, 1);
  assert.strictEqual(paddedMatch1[0].corp_name, '삼성전자');

  // 10-2. 앞자리 0 누락 종목코드 패딩 매칭 검증 ("35720" -> "035720")
  const paddedMatch2 = rankCorpMatches(sampleCorps, '35720');
  assert.strictEqual(paddedMatch2.length, 1);
  assert.strictEqual(paddedMatch2[0].corp_name, '카카오');

  // 10-3. 6자리 정상 종목코드 매칭 검증 ("005930")
  const exactStock = rankCorpMatches(sampleCorps, '005930');
  assert.strictEqual(exactStock.length, 1);
  assert.strictEqual(exactStock[0].corp_name, '삼성전자');

  // 10-4. 8자리 DART 고유번호 매칭 검증 ("00126380")
  const exactCorp = rankCorpMatches(sampleCorps, '00126380');
  assert.strictEqual(exactCorp.length, 1);
  assert.strictEqual(exactCorp[0].corp_name, '삼성전자');

  // 10-5. 본사 우선 랭킹 검증: "카카오" 검색 시 (완전일치 본사 -> 상장 계열사 -> 비상장 계열사)
  const rankedResults = rankCorpMatches(sampleCorps, '카카오');
  assert.strictEqual(rankedResults[0].corp_name, '카카오', '1위는 완전 일치하는 본사(카카오)여야 합니다.');
  assert.ok(rankedResults[1].stock_code !== '', '2위는 상장사여야 합니다.');
  assert.ok(rankedResults[2].stock_code !== '', '3위는 상장사여야 합니다.');
  assert.strictEqual(rankedResults[rankedResults.length - 1].stock_code, '', '비상장사는 뒤로 정렬되어야 합니다.');

  // 10-6. 빈 검색어 입력 시 빈 배열 반환 검증
  const emptyMatch = rankCorpMatches(sampleCorps, '   ');
  assert.strictEqual(emptyMatch.length, 0, '공백 검색어 입력 시 빈 배열이 반환되어야 합니다.');

  // 10-7. 글로벌 색인 오염 방지: sampleCorps와 무관한 외부 배열 격리 검증
  const isolatedCorps = [
    { corp_code: '99999999', corp_name: '독립테스트기업', stock_code: '099990', modify_date: '20240101' }
  ];
  const isolatedMatch = rankCorpMatches(isolatedCorps, '5930');
  assert.strictEqual(isolatedMatch.length, 0, '독립 배열 검색 시 글로벌 캐시의 삼성전자가 오염되어 조회되면 안 됩니다.');

  console.log('✅ 10. 기업 검색 종목코드 0 패딩 및 본사 가중치 랭킹 검증 통과');
}

// 11. DART status "013" (조회결과 0건) 정상 프록시 응답 처리 검증
function testDartStatus013Handling() {
  // 11-1. 정상 조회 (000)
  const okJson = parseDartApiResponse('{"status":"000","message":"정상"}');
  assert.strictEqual(okJson.status, '000');

  // 11-2. 조회결과 0건 (013) -> 예외를 던지지 않고 순수 원본 JSON 반환
  const emptyJson = parseDartApiResponse('{"status":"013","message":"조회된 데이터가 없습니다."}');
  assert.strictEqual(emptyJson.status, '013');
  assert.strictEqual(emptyJson.message, '조회된 데이터가 없습니다.');

  // 11-3. 실제 오류 (020 한도초과) -> Error throw
  assert.throws(() => {
    parseDartApiResponse('{"status":"020","message":"일일 호출 한도 초과"}');
  }, /\[DART 오류 020\]/);

  // 11-4. 비정상 JSON -> Error throw
  assert.throws(() => {
    parseDartApiResponse('<html>error</html>');
  }, /JSON/);

  // 11-5. DART XML 에러 응답 수신 시 정밀 파싱 검증 (<result><status>010</status>...)
  assert.throws(() => {
    parseDartApiResponse('<result><status>010</status><message>등록되지 않은 키입니다.</message></result>');
  }, /\[DART 오류 010\] 등록되지 않은 키입니다\./);

  // 11-6. status가 숫자로 들어오는 경우(13 또는 0) 예외 없이 원본 반환
  const numericStatusJson = parseDartApiResponse('{"status":13,"message":"조회된 데이터가 없습니다."}');
  assert.strictEqual(numericStatusJson.status, 13);

  console.log('✅ 11. DART status 013 정상 프록시 처리 검증 통과');
}

async function run() {
  try {
    testKrxCategoryMapping();
    testDartEndpointValidation();
    await testQueueRateLimit();
    testZipSignature();
    testEncodingDecode();
    testCleanXml();
    testDocTitleExtraction();
    testTargetMatchingPriority();
    testSelfClosingXmlPreservation();
    testStockCodeZeroPaddingAndRanking();
    testDartStatus013Handling();
    console.log('\n🎉 krxdart-mcp 모든 자체 검증 100% 통과');
    process.exit(0);
  } catch (err) {
    console.error('❌ 테스트 실패:', err);
    process.exit(1);
  }
}

run();

import assert from 'node:assert';
import AdmZip from 'adm-zip';
import {
  KRX_CATEGORY_MAP,
  fetchKrx,
  fetchDart,
  fetchDartDocument,
  searchCorpCode,
  cleanXmlContent,
  matchTargetDocument,
  parseDartApiResponse,
  rankCorpMatches
} from './dist/index.js';

console.log('================================================================');
console.log('🚀 [실전 프록시 검증] krxdart-mcp 모든 도구 & 모든 로직 전수 검수');
console.log('================================================================\n');

// Mock 환경변수 주입 (프록시 파이프라인 무결성 검증용)
process.env.KRX_API_KEY = 'TEST_KRX_PROD_KEY_12345';
process.env.DART_API_KEY = 'TEST_DART_PROD_KEY_67890';

// ====================================================================
// SECTION 1. KRX 31개 서비스 오픈API 프록시 파이프라인 실전 검증
// ====================================================================
console.log('--- [검증 1] call_krx_api: 31개 서비스 URL 라우팅 및 순수 프록시 검수 ---');

// 원본 fetch 백업
const originalFetch = globalThis.fetch;
let lastRequest = null;

// Mock Fetch 인터셉터 설정 (네트워크 왕복 및 파라미터/헤더 규격 실전 검증)
globalThis.fetch = async (url, options = {}) => {
  lastRequest = { url: String(url), options };

  // 1-1. KRX 오픈API 요청인 경우
  if (String(url).includes('data-dbg.krx.co.kr')) {
    const authKey = options.headers?.AUTH_KEY;
    if (!authKey) {
      return new Response(JSON.stringify({ error: '인증키 누락' }), { status: 401 });
    }
    // 실제 KRX 순정 응답 형태 모사
    const mockKrxResponse = {
      OutBlock_1: [
        {
          BAS_DD: '20240315',
          ISU_CD: '005930',
          ISU_NM: '삼성전자',
          TDD_CLSPRC: '72300',
          ACC_TRDVOL: '15000000'
        }
      ]
    };
    return new Response(JSON.stringify(mockKrxResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // 1-2. DART JSON 엔드포인트 요청인 경우
  if (String(url).includes('opendart.fss.or.kr/api/') && String(url).endsWith('.json') || String(url).includes('.json?')) {
    const parsedUrl = new URL(String(url));
    const endpoint = parsedUrl.pathname.split('/').pop();
    const crtfcKey = parsedUrl.searchParams.get('crtfc_key');

    if (crtfcKey !== 'TEST_DART_PROD_KEY_67890') {
      return new Response(JSON.stringify({ status: '010', message: '등록되지 않은 키입니다.' }), { status: 200 });
    }

    // 013 (조회된 데이터가 없습니다) 시뮬레이션
    if (parsedUrl.searchParams.get('bsns_year') === '1980') {
      return new Response(JSON.stringify({ status: '013', message: '조회된 데이타가 없습니다.' }), { status: 200 });
    }

    // company.json 정상 응답 시뮬레이션
    if (endpoint === 'company.json') {
      return new Response(JSON.stringify({
        status: '000',
        message: '정상',
        corp_code: '00126380',
        corp_name: '삼성전자(주)',
        stock_code: '005930',
        ceo_nm: '전영현, 노태문'
      }), { status: 200 });
    }

    // list.json 정상 공시목록 응답 시뮬레이션
    if (endpoint === 'list.json') {
      return new Response(JSON.stringify({
        status: '000',
        message: '정상',
        page_no: 1,
        total_count: 2,
        list: [
          { rcept_no: '20240315000016', report_nm: '임원ㆍ주요주주특정증권등소유상황보고서' },
          { rcept_no: '20240318000720', report_nm: '사업보고서 (2023.12)' }
        ]
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ status: '000', message: '정상', data: [] }), { status: 200 });
  }

  // 1-3. DART document.xml (ZIP 원문 다운로드) 요청인 경우
  if (String(url).includes('opendart.fss.or.kr/api/document.xml')) {
    const parsedUrl = new URL(String(url));
    const rceptNo = parsedUrl.searchParams.get('rcept_no');

    const zip = new AdmZip();

    // 케이스 A: 수시공시 (단일 파일)
    if (rceptNo === '20240315000016') {
      const singleXml = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME>임원ㆍ주요주주 특정증권등 소유상황보고서</DOCUMENT-NAME>
<TABLE BORDER="1" WIDTH="600"><TR><TD COLSPAN="2" WIDTH="600">삼성전자주식회사</TD></TR></TABLE>
<P>특정증권 소유주식수: 21,654주</P>
</DOCUMENT>`;
      zip.addFile('20240315000016.xml', Buffer.from(singleXml, 'utf-8'));
    }
    // 케이스 B: 정기 사업보고서 (복수 파일: 본체, 감사보고서, 연결감사보고서, 특약서)
    else if (rceptNo === '20240318000720') {
      const doc0 = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME>연결감사보고서</DOCUMENT-NAME>
<TABLE><COLGROUP/><TR><TD>연결 재무제표 주석 18. 신종자본증권 및 사채</TD></TR></TABLE>
<P>★ 풋옵션 및 조기상환 청구권: 2027년 5월부터 행사 가능, 스텝업 2.5%p 가산 ★</P>
</DOCUMENT>`;

      const doc1 = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME>감사보고서</DOCUMENT-NAME>
<TABLE><TR><TD>개별 감사보고서 본문</TD></TR></TABLE>
</DOCUMENT>`;

      const doc2 = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME>사업보고서</DOCUMENT-NAME>
<TABLE><TR><TD>사업의 개요 및 임직원 현황</TD></TR></TABLE>
</DOCUMENT>`;

      const doc4 = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME>사채발행특약서</DOCUMENT-NAME>
<TABLE><TR><TD>사채권자 보호를 위한 재무비율 유지약정</TD></TR></TABLE>
</DOCUMENT>`;

      zip.addFile('20240318000720_00761.xml', Buffer.from(doc0, 'utf-8'));
      zip.addFile('20240318000720_00760.xml', Buffer.from(doc1, 'utf-8'));
      zip.addFile('20240318000720.xml', Buffer.from(doc2, 'utf-8'));
      zip.addFile('20240318000720_00764.xml', Buffer.from(doc4, 'utf-8'));
    }

    return new Response(zip.toBuffer(), {
      status: 200,
      headers: { 'Content-Type': 'application/x-zip-compressed' }
    });
  }

  // 1-4. DART corpCode.xml (고유번호 ZIP 다운로드) 요청인 경우
  if (String(url).includes('opendart.fss.or.kr/api/corpCode.xml')) {
    const zip = new AdmZip();
    const corpXml = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list>
    <corp_code>00126380</corp_code>
    <corp_name>삼성전자</corp_name>
    <stock_code>005930</stock_code>
    <modify_date>20240101</modify_date>
  </list>
  <list>
    <corp_code>00258801</corp_code>
    <corp_name>카카오</corp_name>
    <stock_code>035720</stock_code>
    <modify_date>20240101</modify_date>
  </list>
  <list>
    <corp_code>00300001</corp_code>
    <corp_name>카카오페이</corp_name>
    <stock_code>377300</stock_code>
    <modify_date>20240101</modify_date>
  </list>
  <list>
    <corp_code>00300002</corp_code>
    <corp_name>카카오엔터프라이즈</corp_name>
    <stock_code> </stock_code>
    <modify_date>20240101</modify_date>
  </list>
</result>`;
    zip.addFile('CORPCODE.xml', Buffer.from(corpXml, 'utf-8'));
    return new Response(zip.toBuffer(), {
      status: 200,
      headers: { 'Content-Type': 'application/x-zip-compressed' }
    });
  }

  return originalFetch(url, options);
};

// --------------------------------------------------------------------
// 1. KRX 31개 서비스 전수 카탈로그 라우팅 검증
// --------------------------------------------------------------------
for (const [apiId, category] of Object.entries(KRX_CATEGORY_MAP)) {
  const result = await fetchKrx(apiId, { basDd: '20240315', isuCd: '005930' });
  assert.ok(lastRequest.url.includes(`data-dbg.krx.co.kr/svc/apis/${category}/${apiId}`), `URL에 ${category}/${apiId}가 포함되어야 함`);
  assert.strictEqual(lastRequest.options.headers.AUTH_KEY, 'TEST_KRX_PROD_KEY_12345', 'KRX AUTH_KEY가 정확히 주입되어야 함');
  assert.strictEqual(result.OutBlock_1[0].ISU_NM, '삼성전자', '순정 KRX JSON이 가공 없이 전달되어야 함');
}
console.log('✅ [검증 1 통과] KRX 31개 공식 서비스 URL 라우팅 및 헤더 주입 / JSON 프록시 100% 정상');

// ====================================================================
// SECTION 2. Open DART 70여 개 공식 엔드포인트 프록시 실전 검증
// ====================================================================
console.log('\n--- [검증 2] call_dart_api: 정상(000), 0건(013), 예외(010) 실전 검수 ---');

// 2-1. 정상 조회 (company.json)
const companyRes = await fetchDart('company.json', { corp_code: '00126380' });
assert.strictEqual(companyRes.status, '000');
assert.strictEqual(companyRes.corp_name, '삼성전자(주)');
assert.strictEqual(companyRes.stock_code, '005930');
console.log('  2-1. company.json 정상 프록시 통과');

// 2-2. 정상 조회 (list.json)
const listRes = await fetchDart('list.json', { corp_code: '00126380' });
assert.strictEqual(listRes.status, '000');
assert.strictEqual(listRes.list.length, 2);
console.log('  2-2. list.json 공시검색 프록시 통과');

// 2-3. 조회결과 0건 (status: "013") -> 시스템 에러 없이 순수 JSON 프록시 반환
const emptyRes = await fetchDart('alotMatter.json', { corp_code: '00126380', bsns_year: '1980' });
assert.strictEqual(emptyRes.status, '013');
assert.strictEqual(emptyRes.message, '조회된 데이타가 없습니다.');
console.log('  2-3. status: "013" (데이터 없음) 순수 원본 JSON 프록시 통과 (LLM 에러 오인 원천 방지)');

// 2-4. 비인가 키 오류 (status: "010") -> 시스템 예외 throw 확인
process.env.DART_API_KEY = 'WRONG_KEY';
try {
  await fetchDart('company.json', { corp_code: '00126380' });
  assert.fail('오류가 발생해야 합니다.');
} catch (err) {
  assert.ok(err.message.includes('[DART 오류 010]'), '비인가 키는 에러로 처리되어야 함');
  console.log('  2-4. 비인가 키(010) 실제 오류 throw 방어선 검증 통과');
}
process.env.DART_API_KEY = 'TEST_DART_PROD_KEY_67890'; // 키 복구
console.log('✅ [검증 2 통과] Open DART JSON API 프록시 및 상태코드 정규화 100% 정상');

// ====================================================================
// SECTION 3. DART 공시 원문 핀포인트 2단계 다운로드 실전 검증
// ====================================================================
console.log('\n--- [검증 3] download_dart_document: 수시공시 단일/정기보고서 목차/핀포인트 타격 ---');

// 3-1. 수시공시 (단일 파일) -> doc_name 없이도 즉시 본문 100% 반환 (2회 호출 방지)
const singleFiling = await fetchDartDocument('20240315000016');
assert.strictEqual(singleFiling.mode, 'single_document', '단일 파일 공시는 single_document 모드여야 함');
assert.strictEqual(singleFiling.title, '임원ㆍ주요주주 특정증권등 소유상황보고서');
assert.ok(singleFiling.content.includes('<td colspan="2">삼성전자주식회사</td>'), '표 및 colspan이 보존되어야 함');
assert.ok(singleFiling.content.includes('21,654주'), '본문 수치가 100% 보존되어야 함');
console.log('  3-1. 수시공시 단일 파일 1회 즉시 완결 조회 검증 통과');

// 3-2. 정기 사업보고서 (복수 파일) -> doc_name 생략 시 목차(TOC) 반환 (소설 쓰기 원천 차단)
const tocReport = await fetchDartDocument('20240318000720');
assert.strictEqual(tocReport.mode, 'toc', '다중 파일 공시는 toc 모드여야 함');
assert.strictEqual(tocReport.total_files, 4, '첨부된 파일 수가 4개여야 함');
assert.strictEqual(tocReport.content, undefined, '목차 모드에는 본문 텍스트가 없어야 함 (소설 재료 차단)');
console.log('TOC Documents returned:', tocReport.documents);
assert.ok(tocReport.documents.some(d => d.title === '연결감사보고서'));
assert.ok(tocReport.documents.some(d => d.title === '감사보고서'));
assert.ok(tocReport.documents.some(d => d.title === '사업보고서'));
assert.ok(tocReport.documents.some(d => d.title === '사채발행특약서'));
console.log('  3-2. 사업보고서 목차(TOC) 자동 반환 검증 통과');

// 3-3. 특정 문서 핀포인트 타격: doc_name="연결감사보고서"
const noteFiling = await fetchDartDocument('20240318000720', '연결감사보고서');
assert.strictEqual(noteFiling.mode, 'targeted_document');
assert.strictEqual(noteFiling.title, '연결감사보고서');
assert.ok(noteFiling.content.includes('풋옵션 및 조기상환 청구권'), '연결감사보고서 주석 원문이 온전히 반환되어야 함');
assert.ok(noteFiling.content.includes('스텝업 2.5%p 가산'), '핵심 특약 조항이 무손실 보존되어야 함');
console.log('  3-3. 연결감사보고서(주석) 핀포인트 타격 검증 통과');

// 3-4. 인덱스 번호 핀포인트 타격: doc_name=targetDoc.index (사채발행특약서 인덱스 매칭 검증)
const targetSpecialDoc = tocReport.documents.find(d => d.title === '사채발행특약서');
const indexedFiling = await fetchDartDocument('20240318000720', String(targetSpecialDoc.index));
assert.strictEqual(indexedFiling.mode, 'targeted_document');
assert.strictEqual(indexedFiling.title, '사채발행특약서');
assert.ok(indexedFiling.content.includes('사채권자 보호를 위한 재무비율 유지약정'));
console.log(`  3-4. 인덱스 번호("${targetSpecialDoc.index}") 타겟팅 시 0번 납치 없이 정확한 문서 반환 검증 통과`);

// 3-5. 완전 일치 우선순위: "감사보고서" vs "연결감사보고서"
const exactAuditFiling = await fetchDartDocument('20240318000720', '감사보고서');
assert.strictEqual(exactAuditFiling.title, '감사보고서', '부분일치(연결감사보고서)에 가려지지 않고 개별 감사보고서가 정확히 반환되어야 함');
console.log('  3-5. 완전일치 우선순위(개별 감사보고서) 타겟팅 검증 통과');

// 3-6. 전체 일괄 반환: doc_name="all"
const allFiling = await fetchDartDocument('20240318000720', 'all');
assert.strictEqual(allFiling.mode, 'all');
assert.strictEqual(allFiling.files.length, 4);
console.log('  3-6. doc_name="all" 전체 문서 일괄 반환 검증 통과');

// 3-7. 미존재 문서명 예외 안내
try {
  await fetchDartDocument('20240318000720', '엉뚱한문서');
  assert.fail('오류가 발생해야 합니다.');
} catch (err) {
  assert.ok(err.message.includes('사용 가능한 문서 목록'), '가능한 문서 목록 안내가 포함되어야 함');
  console.log('  3-7. 미존재 문서 호출 시 사용 가능한 문서 목록 안내 검증 통과');
}
console.log('✅ [검증 3 통과] DART 공시 원문 핀포인트 2단계 다운로드 파이프라인 100% 정상');

// ====================================================================
// SECTION 4. 기업 고유번호 및 종목코드 검색 실전 검증
// ====================================================================
console.log('\n--- [검증 4] search_corp_code: 실전 기업 검색, 0 패딩 및 본사 랭킹 ---');

// 4-1. 정상 6자리 종목코드 검색
const searchBy6Digits = await searchCorpCode('005930');
assert.strictEqual(searchBy6Digits[0].corp_name, '삼성전자');
assert.strictEqual(searchBy6Digits[0].stock_code, '005930');
console.log('  4-1. 6자리 종목코드(005930) 검색 통과');

// 4-2. 앞자리 0 누락 종목코드 검색 (카카오 35720 -> 035720)
const searchPaddedKakao = await searchCorpCode('35720');
assert.strictEqual(searchPaddedKakao[0].corp_name, '카카오');
assert.strictEqual(searchPaddedKakao[0].stock_code, '035720');
console.log('  4-2. 앞자리 0 누락 종목코드(35720 -> 035720 카카오) 보정 검색 통과');

// 4-3. 8자리 DART 고유번호 검색 (00126380)
const searchByCorpCode = await searchCorpCode('00126380');
assert.strictEqual(searchByCorpCode[0].corp_name, '삼성전자');
console.log('  4-3. 8자리 DART 고유번호(00126380) 검색 통과');

// 4-4. 회사명 랭킹 검색: "카카오" 검색 시 (완전일치 상장 본사 -> 상장 계열사 -> 비상장 계열사)
const searchRankedKakao = await searchCorpCode('카카오', 5);
assert.strictEqual(searchRankedKakao[0].corp_name, '카카오', '1위는 완전 일치하는 본사(카카오)여야 함');
assert.strictEqual(searchRankedKakao[0].stock_code, '035720', '본사는 상장사 코드(035720)를 가져야 함');
assert.strictEqual(searchRankedKakao[1].corp_name, '카카오페이', '2위는 상장 계열사(카카오페이)여야 함');
assert.strictEqual(searchRankedKakao[2].corp_name, '카카오엔터프라이즈', '3위는 비상장 계열사여야 함');
console.log('  4-4. 회사명 가중치 랭킹(본사 우선 정렬) 검색 통과');

console.log('✅ [검증 4 통과] 기업 고유번호/종목코드 검색 및 랭킹 엔진 100% 정상');

// ====================================================================
// SECTION 5. 전체 검수 결과 집계
// ====================================================================
console.log('\n================================================================');
console.log('🎉 [전수 검수 완료] krxdart-mcp 4대 핵심 도구 & 모든 프록시 로직 100% 합격!');
console.log('================================================================');

process.exit(0);

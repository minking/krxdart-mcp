# krxdart-mcp

금융감독원 Open DART 및 한국거래소(KRX) 공식 오픈API를 100% 원형 그대로 중계하는 고성능 경량 MCP(Model Context Protocol) 서버.

---

## 🛠️ 제공 도구 (총 4개)

인위적인 래퍼 함수나 데이터 가공 없이, 원천 JSON을 그대로 LLM에 전달합니다. LLM은 스키마에 내장된 전수 카탈로그를 참조하여 필요한 API를 직접 호출합니다.

### 1. `call_dart_api` (Open DART 70여 개 공식 엔드포인트 전수 지원)
- **파라미터**:
  - `endpoint` (string): DART 공식 JSON 엔드포인트 파일명
  - `params` (object): 요청 파라미터 (`corp_code`, `bsns_year`, `reprt_code` 등)
- **주요 지원 카탈로그**:
  - **재무제표**: `fnlttMultiAcnt.json`(최대 10개사 주요계정 일괄비교), `fnlttSinglAcnt.json`(단일회사 주요계정), `fnlttSinglAcntAll.json`(전체 재무제표)
  - **공시검색/개황**: `list.json`(공시목록 검색), `company.json`(기업개황)
  - **정기보고서 세부정보**: `alotMatter.json`(배당), `hyslrSttus.json`(최대주주), `mrhlSttus.json`(소액주주), `exctvSttus.json`(임원), `empSttus.json`(직원), `indvdlByPay.json`(5억이상 보수)
  - **지분공시**: `majorstock.json`(대량보유 5% 보고), `elestock.json`(임원/주요주주 소유상황)
  - **주요사항보고서**: `ic.json`(유상증자), `cvbd.json`(전환사채), `act.json`(자기주식취득), `mrg.json`(합병) 등 24종

### 2. `call_krx_api` (한국거래소 공식 31개 서비스 전수 지원)
- **파라미터**:
  - `api_id` (string): KRX 31개 공식 서비스 ID
  - `params` (object): 요청 파라미터 (`basDt`, `isuCd`, `isin` 등)
- **주요 지원 카탈로그**:
  - **주식(8)**: `stk_bydd_trd`(코스피 일별시세), `ksq_bydd_trd`(코스닥), `knx_bydd_trd`(코넥스), `stk_isu_base_info`(코스피 종목정보), `ksq_isu_base_info` 등
  - **증권상품(3)**: `etf_bydd_trd`(ETF 일별시세), `etn_bydd_trd`, `elw_bydd_trd`
  - **지수(5)**: `krx_dd_trd`(KRX시리즈), `kospi_dd_trd`(KOSPI), `kosdaq_dd_trd`(KOSDAQ), `bon_dd_trd`
  - **채권(3)**: `kts_bydd_trd`(국채전문), `bnd_bydd_trd`(일반채권), `smb_bydd_trd`
  - **파생(6)**: `fut_bydd_trd`(선물), `opt_bydd_trd`(옵션), `eqsfu_stk_bydd_trd`(주식선물) 등
  - **일반상품(3)**: `gold_bydd_trd`(금), `oil_bydd_trd`(석유), `ets_bydd_trd`(배출권)
  - **ESG(3)**: `sri_bond_info`, `esg_index_info`, `esg_etp_info`

### 3. `download_dart_document` (공시 원문 서류 ZIP 다운로드 및 텍스트 추출)
- **파라미터**:
  - `rcept_no` (string): 14자리 공시 접수번호 (예: `20240312000784`)
  - `max_chars` (number, 기본값: `8000`): 반환할 최대 글자 수 제한 (`0` 지정 시 무제한 반환)
- **특징**:
  - 과거 공시 서류의 EUC-KR 및 UTF-8 인코딩 자동 감지 및 디코딩.
  - 대용량 문서 다운로드 시 LLM 컨텍스트 윈도우 오버플로우를 막는 안전장치 내장.

### 4. `search_corp_code` (기업 고유번호 / 종목코드 검색)
- **파라미터**:
  - `query` (string): 회사명(예: "삼성전자"), 6자리 종목코드("005930"), 또는 8자리 고유번호("00126380")
  - `limit` (number, 기본값: `10`): 최대 반환 건수
- **특징**:
  - `corpCode.xml` 최초 1회 다운로드 후 OS 임시 디렉토리에 24시간 원자적 캐싱.
  - 종목코드 6자리 및 고유번호 8자리는 O(1) 초고속 인덱스 검색.

---

## ⚙️ MCP 연동 설정

클라이언트 설정 파일(예: `claude_desktop_config.json` 또는 Antigravity mcp 설정)에 등록합니다:

```json
{
  "mcpServers": {
    "krxdart-mcp": {
      "command": "node",
      "args": ["<설치경로>/krxdart-mcp/dist/index.js"],
      "env": {
        "DART_API_KEY": "금융감독원_OpenDART_API_KEY",
        "KRX_API_KEY": "한국거래소(openapi.krx.co.kr)_AUTH_KEY"
      }
    }
  }
}
```

---

## 🚀 로컬 빌드 및 자체 검증

```bash
# 의존성 설치 및 TypeScript 빌드
npm install
npm run build

# 자체 무결성 검증 (6개 테스트)
npm test
```

---

## 📄 라이선스
MIT License (c) 2026 minki

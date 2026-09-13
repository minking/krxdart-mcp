# krxdart-mcp

**금융감독원 전자공시시스템(DART) + 한국거래소(KRX) 시장 데이터 통합 초경량 MCP 서버**  
*DART 법정공시 원천 데이터와 KRX 거래소 공인 시세를 1:1 왜곡 없이 무결하게 제공하는 순수 프록시*

---

## 📌 주요 특징

1. **원천 데이터 1:1 무결성 보존 (순수 프록시)**:
   - DART 오픈API의 모든 계정명, 코드, 금액, 접수번호 및 거래소 공인 시세 데이터를 임의 지표 계산이나 왜곡 없이 100% 원본 그대로 전달합니다.
   - 모든 공시 항목에 DART 공식 웹 뷰어 바로가기 링크(`direct_url`)를 자동 첨부합니다.
2. **다용도 범용성 (`call_dart_api`)**:
   - 특정 분석 용도에 국한되지 않고, DART 오픈API가 제공하는 70여 개 이상의 모든 공식 엔드포인트(기업개요, 정기공시, 주요사항보고서, 자금조달, 지분공시 등)와 모든 파라미터를 자유롭게 호출할 수 있는 범용 도구를 지원합니다.
3. **자금조달 및 채무증권 특화 엔드포인트 완비**:
   - 기업의 **유상증자 결정(`get_capital_increase`)**, **전환사채(CB) 발행결정(`get_convertible_bonds`)**, **신주인수권부사채(BW) 발행결정(`get_bond_with_warrants`)**, **채무증권(회사채/CP/단기사채) 미상환잔액(`get_debt_securities_status`)** 등 핵심 자금조달 공시를 전용 도구로 지원합니다.
4. **한국거래소 공식 시장 시세 연동 (`get_krx_price`)**:
   - `KRX_API_KEY`(공공데이터포털 금융위/KRX 공식 API 키) 지원 및 실시간 거래소 백업 피드 이중화.
   - 기준일 확정 종가, 시가총액, 상장주식수, 52주 최고/최저가뿐만 아니라 원천 전체 응답(`raw_data`)까지 제공하여 원하는 필드를 자유롭게 추출할 수 있습니다.
5. **다중 연도 및 다중 회사 재무 3표 수집**:
   - 단일 회사 최근 N개년(최대 15년) 주요 재무 3표 일괄 수집(`get_multi_year_financials`).
   - 여러 회사의 특정 연도 주요계정을 단 1회로 비교 조회(`get_multi_corp_financials`).
6. **초경량 단일 파일(Ultra-Lean) 아키텍처**:
   - 250ms 순차 동기화 큐(`enqueue`)로 일일 10,000회 제한 방어.
   - 회사 고유번호(`corpCode.xml`) 24시간 디스크/인메모리 캐싱.
   - 외부 무거운 패키지 제로, Node 20/22/24 네이티브 `src/index.ts` 단일 파일 구성.

---

## 🛠️ 제공 도구(Tools) 목록 (총 20종)

### 🌟 범용 호출 및 시세·다중재무 도구
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`call_dart_api`** | `endpoint`, `params` | **DART 오픈API 전체 엔드포인트를 자유롭게 호출하는 만능 범용 도구** |
| **`get_krx_price`** | `stock_code`, `as_of_date`, `include_raw` | 한국거래소(KRX) 기준일 확정 종가, 시가총액, 주식수, 52주 고저가 + 원본 전체(`raw_data`) |
| **`get_multi_year_financials`** | `corp_code`, `years`, `reprt_code`, `fs_div`, `start_year`, `end_year` | 최근 N개년(기본 10년) 표준 주요 재무 3표 일괄 수집 + `direct_url` |
| **`get_multi_corp_financials`** | `corp_code`(콤마 구분), `bsns_year`, `reprt_code` | 여러 기업의 표준 주요계정을 단 1회 호출로 비교 조회 (/api/fnlttMultiAcnt.json) |

### 💰 자금조달 및 채무증권 공시 도구 (신규)
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`get_debt_securities_status`** | `corp_code`, `bsns_year`, `reprt_code` | 채무증권(회사채, CP, 전자단기사채) 발행실적 및 미상환 잔액 현황 |
| **`get_capital_increase`** | `corp_code`, `bgn_de`, `end_de` | 유상증자 결정 (시설/운영/채무상환 자금조달목적 원본) |
| **`get_convertible_bonds`** | `corp_code`, `bgn_de`, `end_de` | 전환사채(CB) 발행결정 (사채권면총액, 전환가액, 자금조달목적 원본) |
| **`get_bond_with_warrants`** | `corp_code`, `bgn_de`, `end_de` | 신주인수권부사채(BW) 발행결정 (사채권면총액, 행사가액 원본) |

### 📂 DART 상세 기업·공시 원천 도구
* **`search_corp_code`**: 회사명 또는 종목코드로 8자리 고유번호 검색 (24시간 캐시)
* **`get_company_info`**: DART 기업 기본개요 (법인구분, 대표자명, 주소, 업종코드 등)
* **`get_disclosures`**: 최근 공시 목록 조회 (`pblntf_ty`, `pblntf_detail_ty`, `sort`, `page_no` 등 전수 지원)
* **`get_key_financials`**: 단일 연도 표준 주요계정 (25개 필수 계정 원본)
* **`get_all_financials`**: 단일 연도 전체 재무제표 (주석 제외 전체 계정 원본)
* **`get_stock_totqy_sttus`**: 주식 총수 현황 (발행주식 총수, 자기주식수, 유통주식수 등)
* **`get_major_shareholders`**: 최대주주 및 특수관계인 지분 현황
* **`get_treasury_stocks`**: 자기주식 취득 및 처분 현황
* **`get_dividend_info`**: 배당에 관한 사항
* **`get_employee_salaries`**: 임직원 수 및 1인 평균 급여액
* **`get_executive_status`**: 임원 현황
* **`get_5percent_reports`**: 주식등의 대량보유 상황보고서 (5% 이상)
* **`get_insider_trading`**: 임원·주요주주 특정증권등 소유상황보고서

---

## ⚙️ Claude Desktop 연동 설정

Claude Desktop 설정 파일(`claude_desktop_config.json`)의 `mcpServers` 블록에 아래와 같이 추가합니다.

### 방법 1. GitHub 원격 무설치 실행 (권장)
```json
{
  "mcpServers": {
    "krxdart-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/krxdart-mcp"],
      "env": {
        "DART_API_KEY": "발급받은_DART_API_KEY",
        "KRX_API_KEY": "선택사항_공공데이터포털_API_KEY"
      }
    }
  }
}
```

### 방법 2. 로컬 소스 빌드 실행
```json
{
  "mcpServers": {
    "krxdart-mcp": {
      "command": "node",
      "args": ["/home/minki/workspace/krxdart-mcp/dist/index.js"],
      "env": {
        "DART_API_KEY": "발급받은_DART_API_KEY",
        "KRX_API_KEY": "선택사항_공공데이터포털_API_KEY"
      }
    }
  }
}
```

---

## 🚀 로컬 빌드 및 테스트

```bash
# 의존성 설치 및 빌드
npm install
npm run build

# 시세 연동 단위 검증
node test.js
```

---

## 📄 라이선스
MIT License (c) 2026 minki

# krxdart-mcp

**금융감독원 전자공시시스템(DART) + 한국거래소(KRX) 시장 데이터 통합 초경량 MCP 서버**  
*박홍기 통합 기업가치·생존 분석 엔진([PH-CVS 3.0 ONE](https://github.com/minking/krxdart-mcp)) 완벽 대응*

---

## 📌 주요 특징

1. **원천 데이터 무결성 보존 (S-A / S-C 등급 공인 증거)**:
   - 금융감독원 DART 오픈API의 계정명, 계정코드, 보고서 금액, 접수번호를 임의 가공 없이 100% 원본 그대로 전달합니다.
   - 모든 공시/재무 항목에 DART 공식 웹 뷰어 바로가기 링크(`direct_url`)를 자동 첨부하여 증거원장 작성을 지원합니다.
2. **한국거래소 공식 시장 시세 연동 (`get_krx_price`)**:
   - `KRX_API_KEY`(공공데이터포털 금융위/KRX 공식 API 키) 지원 및 실시간 거래소 백업 피드 이중화.
   - DART에 없는 **[기준일 확정 종가, 시가총액, 상장주식수, 52주 최고/최저가, 등락률]**을 즉시 확보하여 프롬프트 시작 단계(S0/S1)를 즉시 통과합니다.
   - 휴장일(주말, 공휴일, 야간)에도 가장 최근 확정 거래일의 종가를 자동 보정 선별합니다.
3. **10개년 재무 3표 일괄 시계열 수집기 (`get_multi_year_financials`)**:
   - LLM이 10개년을 1년씩 10번 연속 호출하는 비효율과 토큰 낭비를 제거하고, 단 1회 호출로 최근 10개년 사업보고서 표준 주요 재무 3표(손익, 대차, 현금흐름 25개 계정)를 정돈된 시계열 JSON으로 반환합니다.
4. **기존 [minking/dart-mcp](https://github.com/minking/dart-mcp) 100% 계승 & 단일 파일(Ultra-Lean) 아키텍처**:
   - 250ms 순차 동기화 큐(`enqueue`)를 통해 DART API 일일 10,000회 한도 및 급격한 다중 호출을 차단합니다.
   - 회사 고유번호(`corpCode.xml`) 24시간 디스크/인메모리 캐싱으로 빠른 검색을 보장합니다.
   - 외부 무거운 패키지 제로, Node 20/22/24 네이티브 fetch 기반 `src/index.ts` 단일 파일로 구성되어 있습니다.

---

## 🛠️ 제공 도구(Tools) 목록 (총 15종)

### 🌟 PH-CVS 3.0 ONE 전용 특화 도구
| 도구명 | 주요 파라미터 | 설명 | 증거 등급 |
| :--- | :--- | :--- | :--- |
| **`get_krx_price`** | `stock_code` (6자리), `as_of_date` (선택) | 한국거래소(KRX) 기준일 확정 종가, 시가총액(원/억원), 상장주식수, 52주 고저가 조회 | **S-C** |
| **`get_multi_year_financials`** | `corp_code` (8자리), `years`(기본 10), `fs_div` | 최근 10개년 표준 주요 재무 3표 일괄 수집 + DART 원문 뷰어 링크(`direct_url`) 자동 첨부 | **S-A** |

### 📂 DART 상세 공시 및 재무 도구 (원천 보존)
* **`search_corp_code`**: 회사명 또는 종목코드로 8자리 고유번호 검색 (24시간 캐시)
* **`get_company_info`**: DART 기업 기본개요 (법인구분, 대표자명, 주소, 업종코드 등)
* **`get_disclosures`**: 최근 공시 목록 조회 (`direct_url` 자동 첨부)
* **`get_key_financials`**: 단일 연도 표준 주요계정 (25개 필수 계정)
* **`get_all_financials`**: 단일 연도 전체 재무제표 (주석 제외 전체 계정)
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
# 1. 의존성 설치 및 TypeScript 컴파일
npm install
npm run build

# 2. 시세 연동 자체 검증
node test.js
```

---

## 📄 라이선스
MIT License (c) 2026 minki

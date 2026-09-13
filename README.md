# krxdart-mcp

금융감독원 Open DART 및 한국거래소(KRX) 주식시세 공식 API MCP 서버.

## 🛠️ 제공 도구

### 1. 원천 데이터 프록시 도구 (Raw API Proxy)

| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`call_dart_api`** | `endpoint`, `params` | **금융감독원 Open DART의 모든 공식 엔드포인트(/api/*)를 호출하여 원본 JSON을 그대로 반환**<br/>(예: `/company.json`, `/fnlttSinglAcnt.json`, `/list.json`, `/detSecIsu.json`, `/piicDecsn.json` 등 70여 개 공식 API 전체 지원) |
| **`call_krx_api`** | `endpoint`, `params` | **한국거래소(KRX)/금융위 공공데이터포털 주식시세정보 공식 API 원본 JSON 반환**<br/>(`getStockPriceInfo`: 일별 시세/시계열, `getItemInfo`: 종목정보 등) |
| **`download_dart_document`** | `rcept_no` | **DART 공시 접수번호(14자리)의 법정 공시서류(ZIP)를 내려받아 파일 목록과 디코딩된 텍스트 본문 반환**<br/>(※ 대용량 문서 시 응답 크기가 클 수 있음) |

### 2. 브릿지 유틸리티 (Utility)

| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`search_corp_code`** | `query`, `limit` | **회사명, 6자리 종목코드("005930"), 또는 8자리 고유번호로 기업 검색**<br/>(종목코드/고유번호는 O(1) 인덱스 매핑, 회사명은 부분 일치 검색) |

---

## ⚙️ MCP 연동 설정

MCP 클라이언트 설정 파일의 `mcpServers` 블록에 아래와 같이 등록합니다.

```json
{
  "mcpServers": {
    "krxdart-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/krxdart-mcp"],
      "env": {
        "DART_API_KEY": "발급받은_DART_API_KEY",
        "KRX_API_KEY": "발급받은_공공데이터포털_API_KEY"
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

# 자체 규격 검증
npm test
```

---

## 📄 라이선스
MIT License (c) 2026 minki

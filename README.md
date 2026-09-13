# krxdart-mcp

**금융감독원 Open DART & 한국거래소(KRX) 공식 시세 순수 API 프록시 MCP 서버 (v2.0.0)**  
*일체의 데이터 가공 없이, 금융감독원과 한국거래소(금융위 공공데이터포털)의 공식 API 원본 JSON을 100% 그대로 전달하는 초경량 순수 인프라*

---

## 📌 핵심 원칙 (Pure Proxy Architecture)

1. **원천 데이터 100% 보존 (No Interpretation)**:
   - MCP가 숫자를 파싱하거나, 날짜를 변환하거나, 파생 지표를 계산하지 않습니다.
   - 정부 및 거래소의 공식 API 응답 JSON을 단 1비트도 변조하지 않고 그대로 전달합니다.
2. **엄격한 공식 API 제약조건 준수**:
   - API Key는 서버 환경변수(`DART_API_KEY`, `KRX_API_KEY`)로만 안전하게 관리되며 파라미터로 노출되지 않습니다.
   - DART(초당 4회, 250ms) 및 KRX(초당 10회, 100ms) 공식 호출 규정을 내부 직렬 큐로 자동 준수합니다.
3. **Fail-Fast 투명한 에러 처리**:
   - 에러 발생 시 결측치를 임의의 값(0 등)으로 위장하지 않고, 원본 오류 코드와 메시지를 명확히 반환합니다.
4. **Tool Surface 최소화 (단 4개의 도구)**:
   - 중복된 수십 개의 래퍼를 없애고, LLM이 혼란 없이 즉시 사용할 수 있는 단 4개의 핵심 도구만 제공합니다.

---

## 🛠️ 제공 도구 (Tools) 목록 (단 4종)

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
        "KRX_API_KEY": "발급받은_공공데이터포털_API_KEY"
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

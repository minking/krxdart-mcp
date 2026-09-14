# krxdart-mcp (Unofficial)

금융감독원 전자공시시스템(Open DART) 및 한국거래소(KRX) 공식 오픈API를 연동하는 비공식 MCP(Model Context Protocol) 서버입니다.

불필요한 가공 없이 Open DART와 KRX 순정 API의 파라미터 규격과 응답 JSON 구조를 1:1 원본 그대로 전달하는 순수 프록시(Pure Proxy) 역할을 수행합니다.

> 안내: 본 프로젝트는 개인이 오픈API를 활용하기 위해 만든 비공식 도구이며, 공시 및 시세 데이터의 권리는 각 기관(금융감독원, 한국거래소)에 있습니다.

---

## 제공 도구 (Tools)

| 도구 (Tool) | 설명 | 파라미터 |
|---|---|---|
| `search_corp_code` | DART 고유번호 파일(`corpCode.xml`) 기반 회사명, 6자리 종목코드, 8자리 고유번호 검색 (인메모리 캐싱) | `query` (회사명/종목코드/고유번호, 필수), `limit` (기본값 10) |
| `call_dart_api` | Open DART 공식 JSON 엔드포인트 70여 개 원본 호출 (재무제표, 기업개황, 공시목록, 배당, 지분 등) | `endpoint` (파일명, 예: `company.json`, `fnlttSinglAcnt.json`), `params` (DART 요청 파라미터 객체) |
| `call_krx_api` | 한국거래소(KRX) 공식 31개 OpenAPI 서비스 원본 호출 (일별시세, 종목기본정보, 지수, ETF, 채권 등) | `api_id` (KRX 서비스 ID, 예: `stk_bydd_trd`), `params` (KRX 요청 파라미터 객체, 예: `basDd`) |
| `download_dart_document` | DART 접수번호(14자리)의 공시 서류(ZIP)를 다운로드하여 텍스트 본문 추출 및 다이렉트 웹 링크 반환 | `rcept_no` (14자리 접수번호, 필수), `max_chars` (최대 글자 수, 기본값 50000, 0은 무제한) |

---

## 지원 API 엔드포인트 안내

### 1. DART 주요 엔드포인트 (`call_dart_api`)
DART에서 제공하는 모든 `.json` 엔드포인트를 호출할 수 있습니다.

* **기업개황 / 공시목록**: `company.json`, `list.json`
* **재무제표 (2015년 이후)**: 
  * `fnlttSinglAcnt.json`: 단일회사 주요 재무계정 (매출, 영업이익 등)
  * `fnlttMultiAcnt.json`: 최대 10개사 다중회사 주요계정 일괄 비교
  * `fnlttSinglAcntAll.json`: 전체 재무제표 모든 계정과목
* **정기보고서 세부정보**:
  * `alotMatter.json` (배당), `hyslrSttus.json` (최대주주), `mrhlSttus.json` (소액주주)
  * `exctvSttus.json` (임원), `empSttus.json` (직원), `indvdlByPay.json` (5억 이상 보수)
* **지분공시**: `majorstock.json` (대량보유 5%), `elestock.json` (임원/주요주주 소유)
* **주요사항보고서**: `ic.json` (유상증자), `cvbd.json` (전환사채), `act.json` (자사주취득), `mrg.json` (합병) 등 24종

### 2. KRX 31개 공식 서비스 (`call_krx_api`)
* **주식 (sto)**: `stk_bydd_trd` (코스피 일별시세), `ksq_bydd_trd` (코스닥), `knx_bydd_trd` (코넥스), `stk_isu_base_info` (코스피 종목정보), `ksq_isu_base_info`, `knx_isu_base_info`, `sw_bydd_trd`, `sr_bydd_trd`
* **증권상품 (etp)**: `etf_bydd_trd` (ETF 일별시세), `etn_bydd_trd`, `elw_bydd_trd`
* **지수 (idx)**: `kospi_dd_trd` (코스피지수), `kosdaq_dd_trd` (코스닥지수), `krx_dd_trd`, `bon_dd_trd`, `drvprod_dd_trd`
* **채권 (bon)**: `kts_bydd_trd` (국채), `bnd_bydd_trd` (일반채권), `smb_bydd_trd` (소액채권)
* **파생상품 (drv)**: `fut_bydd_trd` (선물), `opt_bydd_trd` (옵션), `eqsfu_stk_bydd_trd` (주식선물유가), `eqkfu_ksq_bydd_trd`, `eqsop_bydd_trd`, `eqkop_bydd_trd`
* **일반상품 (gen)**: `gold_bydd_trd` (금), `oil_bydd_trd` (석유), `ets_bydd_trd` (배출권)
* **ESG (esg)**: `sri_bond_info`, `esg_index_info`, `esg_etp_info`

---

## MCP 설정

```json
{
  "mcpServers": {
    "krxdart-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/krxdart-mcp"],
      "env": {
        "DART_API_KEY": "금융감독원_OpenDART_API_KEY",
        "KRX_API_KEY": "한국거래소_오픈API_AUTH_KEY"
      }
    }
  }
}
```

* `DART_API_KEY`: [Open DART](https://opendart.fss.or.kr) 발급 키
* `KRX_API_KEY`: [KRX 오픈API](https://openapi.krx.co.kr) 발급 키

---

## 라이선스
MIT License

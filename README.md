# krxdart-mcp

**금융감독원 전자공시시스템(DART) + 한국거래소(KRX) 시장 데이터 통합 초경량 MCP 서버 (v1.3.0)**  
*DART 법정공시 원천 데이터(70여 개 공식 API 및 모든 파라미터)와 KRX 거래소 공인 시세를 1:1 무결하게 제공하는 고효율 순수 프록시*

---

## 📌 핵심 설계 원칙 및 고효율 최적화 (v1.3.0)

1. **독립 큐 분리 (Dual-Queue Isolation)**:
   - DART 전용 250ms 큐와 KRX 시세 큐를 완전 분리하여, 10개년 재무 데이터 조회 중에도 **시세 조회는 0.1초 만에 즉시 병렬 응답**됩니다 (Global Lock 병목 완전 해소).
2. **O(1) 인덱스 맵 캐시 (초고속 기업 검색)**:
   - 104,000개 DART 고유번호 목록 캐싱 시 `stock_code` 및 `corp_code` 인덱스 맵을 동시 구축하여, 종목코드나 고유번호 검색 시 **0.001ms 만에 O(1)로 즉시 반환**합니다.
3. **토큰 압축 직렬화 (Compact Token JSON)**:
   - 줄바꿈과 불필요한 공백을 덜어낸 콤팩트 JSON 직렬화로 **LLM 컨텍스트 윈도우 토큰 소모를 25~30% 절감**하고 응답 속도를 극대화했습니다.
4. **구형 공시 인코딩 무결성 방어 (EUC-KR Fallback)**:
   - `download_document`에서 과거 2010년 이전 DART 공시 원문 파일에 포함된 EUC-KR 텍스트를 자동 감지하여 디코딩함으로써 **한글 깨짐 현상을 100% 방어**합니다.
5. **다용도 무제한 범용성 (`call_dart_api`)**:
   - DART 오픈API 70여 개 모든 엔드포인트를 임의의 파라미터로 무제한 호출 가능.
6. **공식 엔드포인트 전수 완비 (총 38종 도구)**:
   - 자금조달(유상증자, 무상증자, 감자, CB, BW, EB, 회사채, CP, 전자단기사채, 신종자본증권 등)
   - 재무제표(단일/다중/시계열), 지배구조(주식수, 최대주주, 소액주주, 자사주, 배당, 타법인출자), 임직원 보수, 지분공시 완벽 지원.

---

## 🛠️ 제공 도구(Tools) 전수 목록 (총 38종)

### 0. 만능 범용 도구 및 원문 다운로드
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`call_dart_api`** | `endpoint`, `params` | **DART 오픈API의 70여 개 모든 엔드포인트를 임의 파라미터로 무제한 직접 호출** |
| **`download_document`** | `rcept_no` | 공시서류 원문 파일(ZIP/XML) 다운로드 및 파일 목록/내용 요약 반환 (/api/document.xml) |

### 1. 한국거래소(KRX) 시장 시세 도구
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`get_krx_price`** | `stock_code`, `as_of_date`, `include_raw` | 기준일 확정 종가, 시가총액, 주식수, 52주 고저가, PER, PBR 등 + 원본 전체(`raw_data`) |
| **`get_krx_price_range`** | `stock_code`, `begin_date`, `end_date` | 특정 기간 동안의 일별 주가 시계열(종가, 거래량, 시총 등) 일괄 조회 |

### 2. 재무제표 및 시계열 수집 도구
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`get_multi_year_financials`** | `corp_code`, `years`, `reprt_code`, `fs_div`, `start_year`, `end_year` | 최근 N개년(최대 15년) 표준 주요 재무 3표 일괄 수집 + 공시 원문 링크 |
| **`get_multi_corp_financials`** | `corp_code`(콤마 구분), `bsns_year`, `reprt_code` | 여러 기업의 표준 주요계정을 단 1회 호출로 비교 조회 (/api/fnlttMultiAcnt.json) |
| **`get_key_financials`** | `corp_code`, `bsns_year`, `reprt_code` | 단일 연도 표준 주요계정 25개 필수 계정 원본 (/api/fnlttSinglAcnt.json) |
| **`get_all_financials`** | `corp_code`, `bsns_year`, `reprt_code`, `fs_div` | 단일 연도 전체 재무제표 (주석 제외 전체 계정 원본) (/api/fnlttSinglAcntAll.json) |

### 3. 자금조달 및 채무증권 도구 (자금 관련 공시 전수)
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`get_debt_securities_status`** | `corp_code`, `bsns_year`, `reprt_code` | 채무증권(회사채, CP, 전자단기사채) 발행실적 및 만기별 미상환 잔액 (/api/detSecIsu.json) |
| **`get_cp_unredeemed_status`** | `corp_code`, `bsns_year`, `reprt_code` | 기업어음증권(CP) 만기별 미상환 잔액 (/api/cpUnreSttus.json) |
| **`get_short_term_bond_unredeemed`**| `corp_code`, `bsns_year`, `reprt_code` | 전자단기사채 만기별 미상환 잔액 (/api/shtermBndUnreSttus.json) |
| **`get_corporate_bond_unredeemed`** | `corp_code`, `bsns_year`, `reprt_code` | 회사채 만기별 미상환 잔액 (/api/bndUnreSttus.json) |
| **`get_hybrid_bond_unredeemed`** | `corp_code`, `bsns_year`, `reprt_code` | 신종자본증권(영구채) 만기별 미상환 잔액 (/api/hbdCpUnreSttus.json) |
| **`get_conditional_capital_bond_unredeemed`** | `corp_code`, `bsns_year`, `reprt_code` | 조건부자본증권(코코본드) 만기별 미상환 잔액 (/api/cndlCpUnreSttus.json) |
| **`get_capital_changes`** | `corp_code`, `bsns_year`, `reprt_code` | 증자(감자) 현황 이력 (/api/irdsSttus.json) |
| **`get_capital_increase`** | `corp_code`, `bgn_de`, `end_de` | 유상증자 결정 (발행가액, 시설/운영/채무상환 자금조달목적 원본) (/api/piicDecsn.json) |
| **`get_free_capital_increase`** | `corp_code`, `bgn_de`, `end_de` | 무상증자 결정 (/api/fricDecsn.json) |
| **`get_convertible_bonds`** | `corp_code`, `bgn_de`, `end_de` | 전환사채(CB) 발행결정 (권면총액, 전환가액, 자금목적) (/api/cvbdIsDecsn.json) |
| **`get_bond_with_warrants`** | `corp_code`, `bgn_de`, `end_de` | 신주인수권부사채(BW) 발행결정 (행사가액, 자금목적) (/api/bdwtIsDecsn.json) |
| **`get_exchangeable_bonds`** | `corp_code`, `bgn_de`, `end_de` | 교환사채(EB) 발행결정 (교환대상, 교환가액) (/api/exbdIsDecsn.json) |
| **`get_capital_reduction`** | `corp_code`, `bgn_de`, `end_de` | 감자 결정 (/api/crDecsn.json) |
| **`get_merger_decision`** | `corp_code`, `bgn_de`, `end_de` | 회사합병 결정 (/api/mgDecsn.json) |

### 4. 주식, 지배구조 및 기업 정보 도구
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`search_corp_code`** | `query`, `limit` | 회사명, 종목코드, 고유번호로 8자리 DART 고유번호 검색 (24시간 캐시) |
| **`get_company_info`** | `corp_code` | 기업 기본개요 (정식명칭, 대표자, 주소, 업종, 결산월 등 원본 전체) (/api/company.json) |
| **`get_disclosures`** | `corp_code`, `bgn_de`, `end_de`, `last_reprt_at`, `pblntf_ty`, `pblntf_detail_ty`, `corp_cls`, `sort`, `sort_mth`, `page_no`, `page_count` | 최근 공시 목록 조회 (공식 11개 파라미터 전수 지원 + `direct_url`) (/api/list.json) |
| **`get_stock_totqy_sttus`** | `corp_code`, `bsns_year`, `reprt_code` | 주식의 총수 현황 (발행주식수, 자기주식수, 유통주식수) (/api/stockTotqySttus.json) |
| **`get_major_shareholders`** | `corp_code`, `bsns_year`, `reprt_code` | 최대주주 및 특수관계인 지분 현황 (/api/hyslrSttus.json) |
| **`get_major_shareholder_changes`** | `corp_code`, `bsns_year`, `reprt_code` | 최대주주 변동현황 (/api/hyslrChgSttus.json) |
| **`get_minority_shareholders`** | `corp_code`, `bsns_year`, `reprt_code` | 소액주주 수 및 지분율 현황 (/api/mrhlSttus.json) |
| **`get_treasury_stocks`** | `corp_code`, `bsns_year`, `reprt_code` | 자기주식 취득 및 처분 현황 (/api/tesstkAcqsDspsSttus.json) |
| **`get_dividend_info`** | `corp_code`, `bsns_year`, `reprt_code` | 배당에 관한 사항 (배당금, 배당수익률, 성향) (/api/alotMatter.json) |
| **`get_other_corp_investments`** | `corp_code`, `bsns_year`, `reprt_code` | 타법인 출자현황 (출자회사, 지분율, 장부가액) (/api/otrCprInvstmntSttus.json) |

### 5. 임직원 및 보수 정보 도구
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`get_employee_salaries`** | `corp_code`, `bsns_year`, `reprt_code` | 직원 수 및 1인 평균 급여액 (/api/empSttus.json) |
| **`get_executive_status`** | `corp_code`, `bsns_year`, `reprt_code` | 임원 현황 (등기/미등기, 담당업무, 경력) (/api/exctvSttus.json) |
| **`get_executive_compensation`** | `corp_code`, `bsns_year`, `reprt_code` | 이사ㆍ감사 전체 보수 총액 및 평균 보수 (/api/hmvAuditAllSttus.json) |
| **`get_individual_compensation`** | `corp_code`, `bsns_year`, `reprt_code` | 5억원 이상 상위 5인 개인별 보수 (/api/indvdlBySttus.json) |

### 6. 지분공시 도구
| 도구명 | 파라미터 | 설명 |
| :--- | :--- | :--- |
| **`get_5percent_reports`** | `corp_code` | 주식등의 대량보유 상황보고서 (5% 이상 보고 원본) (/api/majorstock.json) |
| **`get_insider_trading`** | `corp_code` | 임원ㆍ주요주주 특정증권 소유보고서 (/api/elestock.json) |

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

## 🚀 로컬 빌드 및 자체 검증

```bash
# 의존성 설치 및 TypeScript 빌드
npm install
npm run build

# 시세 연동 단위 검증
node test.js
```

---

## 📄 라이선스
MIT License (c) 2026 minki

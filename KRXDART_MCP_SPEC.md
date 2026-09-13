# 범용 KRX & Open DART 통합 MCP 서버 (`krxdart-mcp`) 구축 가이드

> **문서 용도**: 다른 독립 프로젝트 디렉토리에서 바로 `krxdart-mcp`를 구축할 수 있도록 작성된 실전 표준 가이드입니다.  
> **설계 원칙**: 오버 엔지니어링 배제(YAGNI), DART/KRX 공식 기능 최대 활용, 직관적이고 안전한 에러 핸들링.

---

## 1. 개요 및 설계 철학

금융감독원 **Open DART**와 한국거래소 **KRX** 데이터를 어떤 AI 에이전트(Antigravity, Claude Desktop, Cursor 등)에서도 바로 호출할 수 있는 표준 MCP(Model Context Protocol) 서버입니다.

- **심플함 우선**: 복잡한 자체 파서나 과도한 추상화를 걷어내고, DART 공식 API와 `pykrx` 라이브러리를 있는 그대로 연결합니다.
- **다중 보고서 처리의 단순화**: DART 자체 공식 API인 `다중회사 주요계정(/fnlttMultiAcnt.json)`을 활용하여 최대 10개 회사의 재무제표를 단 1회의 호출로 안전하게 가져옵니다.
- **텍스트 안전 장치 (Safety Guard)**: 대용량 공시 원문 조회 시 LLM 컨텍스트가 넘치지 않도록 최대 반환 글자 수(기본 8,000자) 제한 및 에러 방지.

---

## 2. 프로젝트 디렉토리 구조 (권장)

새로운 프로젝트 폴더를 만들고 아래와 같이 심플하게 구성합니다:

```text
krxdart-mcp/
├── .env                  # DART_API_KEY 저장
├── requirements.txt      # 의존 라이브러리
├── README.md             # 프로젝트 설명서
└── server.py             # MCP 서버 메인 실행 파일 (단일 파일 완결형)
```

---

## 3. 필수 의존성 (`requirements.txt`)

최소한의 검증된 라이브러리만 사용합니다:

```text
mcp[cli]>=1.0.0
httpx>=0.27.0
pykrx>=1.0.40
python-dotenv>=1.0.0
pandas>=2.0.0
```

---

## 4. 핵심 도구(Tools) 목록 (총 8개)

### [DART 영역: 기업 공시 및 재무]

1. **`dart_search_corp(corp_name: str)`**
   - 회사명으로 DART 고유번호(8자리) 및 종목코드(6자리) 검색.
   - 고유번호 목록(`corpCode.xml`)은 최초 1회 로컬 다운로드 후 자동 재사용.

2. **`dart_get_company(corp_code: str)`**
   - 기업 개황 조회 (대표자, 설립일, 결산월, 주소, 업종, 법인등록번호 등).

3. **`dart_get_filings(corp_code: str, bgn_de: str, end_de: str, pblntf_ty: str = None)`**
   - 기간별 공시 목록 검색 (보고서 10개 목록 파악 시 사용).
   - 공시유형(`pblntf_ty`): A(정기공시), B(주요사항), C(발행공시) 등.

4. **`dart_get_financials(corp_code: str, bsns_year: str, reprt_code: str = "11011", fs_div: str = "CFS")`**
   - 단일 기업의 재무상태표, 손익계산서, 현금흐름표 주요계정 조회.
   - `reprt_code`: 1분기(11013), 반기(11012), 3분기(11014), 사업보고서(11011).
   - `fs_div`: CFS(연결재무제표), OFS(별도재무제표).

5. **`dart_get_multi_financials(corp_codes: list[str], bsns_year: str, reprt_code: str = "11011")`**
   - **다중 기업(최대 10개사) 재무제표 일괄 조회**.
   - DART 공식 API를 활용하여 1회 요청으로 10개사 핵심 계정을 비교 테이블로 반환.

6. **`dart_get_document_text(rcept_no: str, max_chars: int = 8000)`**
   - 특정 공시서류 원문(XML/HTML)을 텍스트로 추출.
   - LLM 컨텍스트 보호를 위해 `max_chars` 초과 시 자동 트렁케이트 처리.

---

### [KRX 영역: 주가 및 시장 수급]

7. **`krx_get_price(stock_code: str, start_date: str, end_date: str)`**
   - 기간별 주가 시세 (시가, 고가, 저가, 종가, 거래량, 등락률).
   - `pykrx` 기반으로 주말/휴장일 자동 제외 처리.

8. **`krx_get_market_cap(stock_code: str, date: str)`**
   - 특정 기준일의 시가총액, 상장주식수, PER, PBR, 배당수익률(DIV).

---

## 5. `server.py` 핵심 구현 레퍼런스 코드

```python
"""
krxdart-mcp: Open DART & KRX 통합 범용 MCP 서버
"""

import os
import io
import zipfile
import xml.etree.ElementTree as ET
import httpx
import pandas as pd
from datetime import datetime
from dotenv import load_dotenv
from pykrx import stock
from mcp.server.fastmcp import FastMCP

load_dotenv()

DART_API_KEY = os.getenv("DART_API_KEY")
DART_BASE_URL = "https://opendart.fss.or.kr/api"

mcp = FastMCP("krxdart-mcp")

# 로컬 캐시: 고유번호 매핑 딕셔너리
CORP_MAP = {}  # {corp_name: {"corp_code": ..., "stock_code": ...}}


def init_corp_codes():
    """DART 고유번호 XML 다운로드 및 캐싱 (최초 1회)"""
    global CORP_MAP
    if CORP_MAP:
        return
    
    url = f"{DART_BASE_URL}/corpCode.xml"
    params = {"crtfc_key": DART_API_KEY}
    with httpx.Client(timeout=30.0) as client:
        res = client.get(url, params=params)
        if res.status_code == 200:
            with zipfile.ZipFile(io.BytesIO(res.content)) as z:
                xml_data = z.read("CORPCODE.xml")
                root = ET.fromstring(xml_data)
                for item in root.findall("list"):
                    c_name = item.findtext("corp_name").strip()
                    c_code = item.findtext("corp_code").strip()
                    s_code = (item.findtext("stock_code") or "").strip()
                    CORP_MAP[c_name] = {"corp_code": c_code, "stock_code": s_code}


@mcp.tool()
def dart_search_corp(corp_name: str) -> dict:
    """회사명으로 DART 고유번호 및 상장 종목코드(티커)를 조회합니다."""
    init_corp_codes()
    info = CORP_MAP.get(corp_name)
    if not info:
        # 부분 일치 검색
        matched = {k: v for k, v in CORP_MAP.items() if corp_name in k}
        if matched:
            return {"status": "PARTIAL_MATCH", "results": dict(list(matched.items())[:5])}
        return {"status": "NOT_FOUND", "message": f"'{corp_name}' 회사를 찾을 수 없습니다."}
    return {"status": "SUCCESS", "corp_name": corp_name, **info}


@mcp.tool()
def dart_get_filings(corp_code: str, bgn_de: str, end_de: str, pblntf_ty: str = "A", page_count: int = 10) -> list:
    """특정 기업의 기간별 공시 목록을 조회합니다 (pblntf_ty: A=정기공시, B=주요사항)."""
    url = f"{DART_BASE_URL}/list.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_code": corp_code,
        "bgn_de": bgn_de,
        "end_de": end_de,
        "pblntf_ty": pblntf_ty,
        "page_count": min(page_count, 100),
    }
    with httpx.Client(timeout=15.0) as client:
        res = client.get(url, params=params)
        data = res.json()
        return data.get("list", [])


@mcp.tool()
def dart_get_financials(corp_code: str, bsns_year: str, reprt_code: str = "11011", fs_div: str = "CFS") -> list:
    """단일 기업의 핵심 재무제표(재무상태표, 손익계산서, 현금흐름표)를 조회합니다."""
    url = f"{DART_BASE_URL}/fnlttSinglAcnt.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_code": corp_code,
        "bsns_year": bsns_year,
        "reprt_code": reprt_code,
        "fs_div": fs_div,
    }
    with httpx.Client(timeout=15.0) as client:
        res = client.get(url, params=params)
        data = res.json()
        return data.get("list", [])


@mcp.tool()
def dart_get_multi_financials(corp_codes: list[str], bsns_year: str, reprt_code: str = "11011") -> list:
    """최대 10개 기업의 주요 재무계정을 일괄 조회하여 횡단 비교합니다."""
    url = f"{DART_BASE_URL}/fnlttMultiAcnt.json"
    params = {
        "crtfc_key": DART_API_KEY,
        "corp_code": ",".join(corp_codes[:10]),
        "bsns_year": bsns_year,
        "reprt_code": reprt_code,
    }
    with httpx.Client(timeout=20.0) as client:
        res = client.get(url, params=params)
        data = res.json()
        return data.get("list", [])


@mcp.tool()
def krx_get_price(stock_code: str, start_date: str, end_date: str) -> list:
    """KRX 종목의 기간별 일별 시세(시가, 고가, 저가, 종가, 거래량 등)를 조회합니다 (날짜형식: YYYYMMDD)."""
    df = stock.get_market_ohlcv_by_date(start_date, end_date, stock_code)
    df = df.reset_index()
    df["날짜"] = df["날짜"].dt.strftime("%Y-%m-%d")
    return df.to_dict(orient="records")


@mcp.tool()
def krx_get_market_cap(stock_code: str, date: str) -> dict:
    """특정 기준일의 시가총액, 상장주식수, PER, PBR 등을 조회합니다 (date: YYYYMMDD)."""
    cap_df = stock.get_market_cap_by_date(date, date, stock_code)
    div_df = stock.get_market_fundamental_by_date(date, date, stock_code)
    
    result = {}
    if not cap_df.empty:
        result.update(cap_df.iloc[0].to_dict())
    if not div_df.empty:
        result.update(div_df.iloc[0].to_dict())
    return result


if __name__ == "__main__":
    mcp.run()
```

---

## 6. MCP 클라이언트 설정 연동 방법

### Antigravity / Claude Desktop 설정 예시

각 클라이언트의 설정 파일(`claude_desktop_config.json` 또는 Antigravity mcp 설정)에 등록합니다:

```json
{
  "mcpServers": {
    "krxdart": {
      "command": "python",
      "args": [
        "c:/경로/krxdart-mcp/server.py"
      ],
      "env": {
        "DART_API_KEY": "발급받은_DART_API_KEY"
      }
    }
  }
}
```

---

## 7. 핵심 장점 요약

1. **완벽한 범용성**: 어떤 프로젝트, 어떤 AI 모델이라도 DART와 KRX 원천 데이터를 실시간 질의 가능.
2. **단일 파일 완결**: `server.py` 한 파일에 약 150줄 내외로 구현되어 디버깅과 유지보수가 극도로 쉬움.
3. **토큰 안전성**: DART 공식 `fnlttSinglAcnt` 및 `fnlttMultiAcnt`가 이미 요약 계정만 정제해 주므로 LLM이 뻗지 않고 10개사/10개 분기를 가볍게 소화.

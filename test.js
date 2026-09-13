import assert from 'node:assert';

// KRX 실시간 시세 파싱 단위 검증
async function testKrxParsing() {
  const url = 'https://m.stock.naver.com/api/stock/005930/integration';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  assert.strictEqual(res.ok, true, 'KRX 피드 HTTP 응답 성공');

  const data = await res.json();
  const dealTrend = data?.dealTrendInfos?.[0];
  const t = data?.totalInfos;
  const getVal = (code) => t?.find((x) => x.code === code)?.value || '';

  const parseNum = (v) => parseFloat(String(v || 0).replace(/,/g, '')) || 0;
  const closePrice = parseNum(dealTrend?.closePrice ?? data?.nowPrice ?? 0);
  assert.ok(closePrice > 0, `종가 정상 확인 (${closePrice})`);

  const marketValueText = getVal('marketValue');
  assert.ok(marketValueText.length > 0, '시가총액 텍스트 존재');

  console.log('✅ [krxdart-mcp Self-Check] 삼성전자 시세 연동 테스트 통과');
  console.log(`   - 종목: ${data?.stockName} (${closePrice.toLocaleString()}원)`);
  console.log(`   - 기준일자: ${dealTrend?.bizdate}`);
  console.log(`   - 시가총액: ${marketValueText}`);
}

testKrxParsing().catch((err) => {
  console.error('❌ Self-Check 실패:', err.message);
  process.exit(1);
});

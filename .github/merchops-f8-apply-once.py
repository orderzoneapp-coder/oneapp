from pathlib import Path
import hashlib

root = Path('.')
expected = {
    'coreEngine.js': '45e14030604ae5b482b2f8dd2df8194e781506ee',
    'MerchOps.html': '5cfdc6161184ef9cd80d611b02009176393ae0bf',
}
texts = {}
for name, sha in expected.items():
    data = (root / name).read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if actual != sha:
        raise SystemExit(f'{name}: baseline changed ({actual}); review instead of overwriting')
    texts[name] = data.decode('utf-8')

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)

for name in texts:
    source = texts[name]
    source = replace_once(source,
        "    const previousPromoGenerated = finalData?._previousPromoApplied === true && fields.includes('행사가');\n    const explicitGenerated =",
        """    const previousPromoGenerated = finalData?._previousPromoApplied === true && fields.includes('행사가');
    // F8-01: legacy estimate drafts need explicit recalculation evidence, not a nonblank final value.
    const legacyMarketPrice = parseNum(finalCell.value);
    const legacyEstimateMarketGenerated = canonicalField === '시중가'
      && sourceRole === 'estimate'
      && finalData?._marketPricePolicy === 'estimate_rule_recalc_allowed'
      && !!(finalData?._ruleAppliedAt || finalData?._isRuleApplied)
      && finalCell.found && !isBlankValue(finalCell.value)
      && Number.isFinite(legacyMarketPrice) && legacyMarketPrice > 0;
    const explicitGenerated =""", name + ' legacy evidence')
    source = replace_once(source,
        "      || previousPromoGenerated\n      || (canonicalField === '출고가'",
        "      || previousPromoGenerated\n      || legacyEstimateMarketGenerated\n      || (canonicalField === '출고가'", name + ' legacy selection')
    source = replace_once(source,
        "    const working = { ...source };\n\n    // v1.0.8 정책:",
        """    const working = { ...source };
    // A new source/calculation must not inherit the previous estimate's generated market-price marker.
    if (hasOwnField(working._generatedFields, '시중가')) {
      working._generatedFields = { ...working._generatedFields };
      delete working._generatedFields['시중가'];
    }

    // v1.0.8 정책:""", name + ' marker reset')
    source = replace_once(source,
        "        working['시중가'] = calculatedOutPrice;\n        working._marketPricePolicy = 'estimate_rule_recalc_allowed';",
        """        working['시중가'] = calculatedOutPrice;
        working._generatedFields = { ...(working._generatedFields || {}), '시중가': true };
        working._marketPricePolicy = 'estimate_rule_recalc_allowed';""", name + ' generated market')
    texts[name] = source
html = texts['MerchOps.html']
html = replace_once(html,
    "                            } else {\n                                recalculated['시중가'] = recalculatedOutPrice || 0;\n                            }",
    """                            } else {
                                recalculated['시중가'] = recalculatedOutPrice || 0;
                                if (activeRoleForRule === 'estimate') {
                                    recalculated._generatedFields = { ...(recalculated._generatedFields || {}), '시중가': true };
                                    recalculated._marketPricePolicy = 'estimate_rule_recalc_allowed';
                                }
                            }""", 'manual rule application')
start = html.index('    const handleQuickExcelExport = useCallback(async () => {')
end = html.index('    const handleCommitEstimate = useCallback(async () => {', start)
f8 = html[start:end]
f8 = replace_once(f8,
    "['품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n', '최종(전송)', 'n', '행사', 'n', '1']",
    "['품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n']", 'ERP header')
f8 = replace_once(f8, ', finalTransmission, shopUploadStock,', ', shopUploadStock,', 'unused output variable')
f8 = replace_once(f8, "                finalTransmission = readQuickSourceNum(row, ['최종전송', '최종(전송)', '최종입고'], '');\n", '', 'estimate transmission')
f8 = replace_once(f8, "                finalTransmission = getBestNumByAliases(row, ['최종전송', '최종(전송)', '최종입고'], '');\n", '', 'other role transmission')
f8 = replace_once(f8,
    """            // ERP는 기초정보 셋팅용이다. 출고가는 정상 출고가, 행사는 행사 컬럼으로 분리한다.
            // ERP업데이트 P열(헤더 '1')은 기본여부다.
            // 판매여부와 무관하게 ERP 입고가가 0보다 크면 1, 입고가가 0·공란이면 공백으로 출력한다.
            const erpBasicFlag = inPrice > 0 ? '1' : '';
            erpData.push([code, inPrice, '0', erpOutPrice, '0', inPriceB, 'n', erpASale, 'n', erpBSale, 'n', finalTransmission, 'n', promoPrice, 'n', erpBasicFlag]);""",
    """            // F8-04: 스마트입력 확정 ERP 11열. 정상 출고가 유지; 행사·최종전송·기본여부는 이 출력에서만 제외한다.
            erpData.push([code, inPrice, '0', erpOutPrice, '0', inPriceB, 'n', erpASale, 'n', erpBSale, 'n']);""", 'normal ERP row')
f8 = replace_once(f8, "            const subErpBasicFlag = subInfo.subIn > 0 ? '1' : '';\n", '', 'subdivision basic flag')
f8 = replace_once(f8, "                erpRow[11] = subInfo.subIn;\n                erpRow[15] = subErpBasicFlag;\n", '', 'existing subdivision trailing fields')
f8 = replace_once(f8,
    "erpData.push([subInfo.code, subInfo.subIn, '0', subInfo.subOut, '0', '', 'n', '', 'n', '', 'n', subInfo.subIn, 'n', '', 'n', subErpBasicFlag]);",
    "erpData.push([subInfo.code, subInfo.subIn, '0', subInfo.subOut, '0', '', 'n', '', 'n', '', 'n']);", 'new subdivision ERP row')
for obsolete in ('finalTransmission', 'erpBasicFlag', 'subErpBasicFlag', 'erpRow[11]', 'erpRow[15]'):
    if obsolete in f8:
        raise SystemExit(f'ERP obsolete F8 reference remains: {obsolete}')
html = html[:start] + f8 + html[end:]
html = replace_once(html, '<script src="coreEngine.js"></script>', '<script src="coreEngine.js?v=20260913-f8-market-erp11"></script>', 'MerchOps Core cache')
html = html.replace('v2.1.196_F8ShopSaleStock', 'v2.1.197_F8MarketERP11')
html = replace_once(html,
    '    // v2.1.196: 견적/시세 F8 쇼핑몰업로드는 출고가로 판매여부를 정하고 재고수량 999를 일관 적용한다.',
    '    // v2.1.197: 계산 시중가의 F8 누락을 수정하고 ERP업데이트를 확정 11열로 통일한다.\n    // v2.1.196: 견적/시세 F8 쇼핑몰업로드는 출고가로 판매여부를 정하고 재고수량 999를 일관 적용한다.', 'version note')
texts['MerchOps.html'] = html
for name, source in texts.items():
    (root / name).write_text(source, encoding='utf-8')
    print('Patched', name)

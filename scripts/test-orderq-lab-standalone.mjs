#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'archive', 'OrderQ_Lab.html');
const html = fs.readFileSync(appPath, 'utf8');

assert.match(html, /ORDER Q LAB/);
assert.match(html, /orderq-lab-workspace\/v1/);
assert.match(html, /쇼핑몰 주문내역/);
assert.match(html, /id="shopFileInput"/);
assert.match(html, /id="shopDateSelect"/);
assert.match(html, /id="shopCommitButton"/);
assert.match(html, /function parseShopMatrix\(matrix/);
assert.match(html, /function analyzeShopDate\(/);
assert.match(html, /function persistStateAtomically\(/);
assert.match(html, /documentNo: ''/);
assert.match(html, /label: '주문'/);
assert.match(html, /label: '기초재고'/);
assert.match(html, /label: '구매'/);
assert.match(html, /label: '판매·출고'/);
assert.match(html, /label: '실사재고'/);
assert.match(html, /label: '상품정보'/);
assert.match(html, /function parseFile\(file, role\)/);
assert.match(html, /function buildProducts\(\)/);
assert.match(html, /function registerRelation\(\)/);
assert.match(html, /function confirmSubstitution\(event\)/);
assert.match(html, /id="workTableBody"/);
assert.match(html, /id="issueFilterButton"/);
assert.match(html, /id="relationButton"/);
assert.match(html, /id="substitutionDialog"/);
assert.match(html, /id="sourceSalesQuantity"/);
assert.match(html, /id="actualOutboundQuantity"/);
assert.match(html, /draggable="true" data-drag-payload/);
assert.match(html, /application\/x-orderq-allocation/);
assert.match(html, /addEventListener\('dragstart'/);
assert.match(html, /addEventListener\('drop'/);
assert.match(html, /conversionAuthority: 'ADMIN_CONFIRMED'/);
assert.match(html, /대체상품 실제 차감수량/);
assert.match(html, /10kg 박스 → 1kg 상품이라도 실제 차감수량을 10으로 자동 확정하지 않습니다/);
assert.doesNotMatch(html, /inferEquivalentTargetQty|calcConvertedUnitCost/);
assert.match(html, /source\.physicalOutbound = round\(source\.physicalOutbound - operation\.sourceSalesQuantity\)/);
assert.match(html, /target\.physicalOutbound = round\(target\.physicalOutbound \+ operation\.actualOutboundQuantity\)/);
assert.match(html, /원본 행은 수정하지 않고 작업 이벤트만 누적합니다/);
assert.match(html, /append\('출고현황'/);
assert.match(html, /append\('발주현황'/);
assert.match(html, /append\('재고수불부'/);
assert.match(html, /append\('창고별재고'/);
assert.match(html, /window\.OrderQLabTestPort/);

const mobileStyles = html.slice(html.indexOf('@media (max-width: 700px)'), html.indexOf('</style>'));
assert.match(mobileStyles, /\.brand\s*\{[^}]*width:\s*100%;[^}]*flex:\s*0 0 100%;[^}]*\}/s, 'mobile brand must own an independent full-width row');
assert.match(mobileStyles, /\.top-actions\s*\{[^}]*width:\s*100%;[^}]*flex:\s*0 0 100%;[^}]*\}/s, 'mobile actions must own an independent full-width row');
assert.match(mobileStyles, /\.top-actions \.btn\s*\{[^}]*width:\s*100%;[^}]*white-space:\s*nowrap;[^}]*\}/s, 'mobile action labels must stay readable without wrapping');
assert.doesNotMatch(mobileStyles, /\.top-actions \.btn\s*\{[^}]*(?:overflow:\s*hidden|text-overflow:\s*ellipsis)/s, 'mobile action labels must not be clipped or ellipsized');
assert.match(mobileStyles, /\[data-shop-theme="light"\] \.top-actions \.btn\.primary\s*\{[^}]*color:\s*#042b27;[^}]*background:\s*var\(--cyan\);[^}]*\}/s, 'light mobile primary action must retain readable contrast');
const topActions = html.match(/<div class="top-actions">([\s\S]*?)<\/div>/)?.[1] || '';
const topActionLabels = [...topActions.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1].trim());
assert.deepEqual(topActionLabels, ['일반모드', '실행취소', '작업 저장', '결과 Excel', '초기화']);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML id attributes must be unique');

const scriptBodies = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter((source) => source.trim());
assert.equal(scriptBodies.length, 1, 'standalone app must have one inline application script');
new Function(scriptBodies[0]);

console.log('OrderQ Lab standalone contract and syntax PASS');

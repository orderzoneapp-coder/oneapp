#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.join(process.cwd(), 'nexus/company-certificate.js')).href;
const { detectCertificateFileType, validateCertificateFile, sanitizeCertificateText, parseBusinessCertificateText } = await import(moduleUrl);

const jpg = Uint8Array.from([0xff,0xd8,0xff,0xe0,0,0]);
const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0]);
const pdf = new TextEncoder().encode('%PDF-1.7\n');
assert.equal(detectCertificateFileType(jpg), 'image/jpeg');
assert.equal(detectCertificateFileType(png), 'image/png');
assert.equal(detectCertificateFileType(pdf), 'application/pdf');
assert.equal(detectCertificateFileType(Uint8Array.from([1,2,3,4,5,6,7,8])), '');
assert.equal(validateCertificateFile({ size: jpg.length, type: 'image/jpeg' }, jpg), 'image/jpeg');
assert.throws(() => validateCertificateFile({ size: jpg.length, type: 'application/pdf' }, jpg), /CERTIFICATE_FILE_SIGNATURE_MISMATCH/);
assert.throws(() => validateCertificateFile({ size: 13 * 1024 * 1024, type: 'image/jpeg' }, jpg), /CERTIFICATE_FILE_SIZE_INVALID/);

const sensitive = sanitizeCertificateText('대표자 이무철 생년월일: 900101-1234567\n주민등록번호 900101-1234567');
assert(!sensitive.includes('900101-1234567'));
assert.match(sensitive, /민감정보 제거/);

const certificateText = `
사업자등록증
사업자등록번호: 380-14-01523
상 호 : 원앱
대 표 자 : 이무철 생년월일 900101-1234567
개 업 연 월 일 : 2021년 04월 29일
사업장 소재지 : 서울특별시 송파구 양재대로 932, 9층 19호
업 태 : 도매 및 소매업
종 목 : 전자상거래 소매업, 상품 중개업
과 세 유 형 : 일반과세자
사업자단위과세 적용 여부 : 부
발 급 사 유 : 정정
발 급 일 : 2021. 07. 28.
관할 세무서 : 송파세무서
`;
const parsed = parseBusinessCertificateText(certificateText, 86);
assert(parsed.documentSignals.includes('BUSINESS_REGISTRATION_CERTIFICATE'));
assert(parsed.documentSignals.includes('BUSINESS_NUMBER'));
assert.equal(parsed.extractedFields.companyName, '원앱');
assert.equal(parsed.extractedFields.businessNumber, '3801401523');
assert.equal(parsed.extractedFields.representativeName, '이무철');
assert.equal(parsed.extractedFields.openingDate, '2021-04-29');
assert.equal(parsed.extractedFields.taxationType, '일반과세자');
assert.deepEqual(parsed.extractedFields.businessTypes, ['도매 및 소매업']);
assert.deepEqual(parsed.extractedFields.businessItems, ['전자상거래 소매업', '상품 중개업']);
assert.equal(parsed.extractedFields.unitTaxationEnabled, false);
assert.equal(parsed.extractedFields.certificateIssueReason, '정정');
assert.equal(parsed.extractedFields.certificateIssuedDate, '2021-07-28');
assert.equal(parsed.extractedFields.taxOfficeName, '송파세무서');
assert(!JSON.stringify(parsed).includes('900101'));
assert(!Object.keys(parsed).some(key => /raw|image|file|birth/i.test(key)));
assert(Object.values(parsed.fieldConfidence).every(score => score >= 0 && score <= 1));

console.log('NEXUS company certificate contract passed (JPG/PNG/PDF signatures, sensitive-data stripping, parsing and confidence).');

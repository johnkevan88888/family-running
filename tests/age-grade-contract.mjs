import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../age-grade-contract.js');

const validRow = {
    AgeGradedStandardSeconds: '1800.000000000000000',
    ValidationTimeSeconds: '3600',
    ValidationAgeGrade: '0.500000000000000',
    CalculationContractVersion: contract.version,
    CalculationContractSignature: contract.signature
};

assert.equal(contract.calculate(1800, 3600), 0.5);
assert.equal(contract.validateRows([validRow]), true);

assert.throws(
    () => contract.validateRows([{ ...validRow, CalculationContractVersion: '2.0' }]),
    /Excel age-grade formula has changed/
);
assert.throws(
    () => contract.validateRows([{ ...validRow, CalculationContractSignature: 'changed' }]),
    /Excel age-grade formula has changed/
);
assert.throws(
    () => contract.validateRows([{ ...validRow, ValidationAgeGrade: '0.51' }]),
    /does not match the workbook conformance value/
);
assert.throws(
    () => contract.validateRows([{ ...validRow, AgeGradedStandardSeconds: '0' }]),
    /invalid age-grade calculator value/
);

console.log('Age-grade master/slave contract tests passed.');

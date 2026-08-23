(function (root, factory) {
    const contract = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = contract;
    }

    root.ageGradeContract = contract;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const version = '1.0';
    const signature = 'AGOC:=[@OC]/[@[Age Factor]]|AGSCORE:=[@[AG OC]]/[@[Time Seconds]]|FORMAT:0.00%';

    function calculate(ageGradedStandardSeconds, elapsedSeconds) {
        return Number(ageGradedStandardSeconds) / Number(elapsedSeconds);
    }

    function validateRows(rows) {
        if (!Array.isArray(rows) || !rows.length) {
            throw new Error('The workbook export contains no age-grade calculator rows.');
        }

        for (const row of rows) {
            if (row.CalculationContractVersion !== version || row.CalculationContractSignature !== signature) {
                throw new Error(
                    'The Excel age-grade formula has changed. The website calculator must be updated in the same release.'
                );
            }

            const standardSeconds = Number(row.AgeGradedStandardSeconds);
            const validationSeconds = Number(row.ValidationTimeSeconds);
            const workbookResult = Number(row.ValidationAgeGrade);
            const websiteResult = calculate(standardSeconds, validationSeconds);

            if (
                !Number.isFinite(standardSeconds) || standardSeconds <= 0 ||
                !Number.isFinite(validationSeconds) || validationSeconds <= 0 ||
                !Number.isFinite(workbookResult) || workbookResult <= 0
            ) {
                throw new Error('The workbook export contains an invalid age-grade calculator value.');
            }

            const tolerance = Math.max(1e-13, Math.abs(workbookResult) * 1e-12);
            if (Math.abs(websiteResult - workbookResult) > tolerance) {
                throw new Error(
                    'The website age-grade result does not match the workbook conformance value.'
                );
            }
        }

        return true;
    }

    return Object.freeze({
        calculate,
        signature,
        validateRows,
        version
    });
});

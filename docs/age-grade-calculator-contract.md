# Age-Grade Calculator Master/Slave Contract

## Ownership

Excel remains the master for every age-grade input and rule. The website does
not receive date of birth, sex, age, the raw open-class standard, or the raw age
factor. For each active athlete and supported distance, the workbook exports the
full-precision age-graded standard in seconds. The browser's only calculation is:

`AgeGrade = AgeGradedStandardSeconds / EnteredTimeSeconds`

This is the narrow calculator exception approved on 23 August 2026. Rankings,
standards, targets, categories, medals, and every stored result remain exported
workbook values.

## Published files

- `data/family/age_grade_calculator.csv`
- `data/everyone/age_grade_calculator.csv`

The ordered schema is:

`AthleteId,Participant,Distance,AgeGradedStandardSeconds,ValidationTimeSeconds,ValidationAgeGrade,CalculationContractVersion,CalculationContractSignature,SortOrder,ExportBundleID`

Each active athlete has exactly one row for each of 5 km, 10 km, 10 Mile, Half
Marathon, and Marathon. Family contains the Family roster; Everyone contains
the Everyone roster. The workbook uses the integer part of its current `Age now`
value and its existing sex/event lookup tables before exporting the combined
standard.

## Fail-closed coupling

The workbook and website must change together when calculation logic changes:

1. Before exporting, VBA verifies that every live `RaceResults` age-graded
   standard formula, score formula, and score number format exactly match the
   declared calculation contract.
2. VBA also checks calculated race-result values against that contract.
3. Every calculator row carries the contract version and the exact live formula
   signature.
4. Every row carries a workbook-generated conformance input and expected result.
5. `age-grade-contract.js` supports one exact version and signature, recomputes
   every conformance row before enabling the calculator, and stops with a clear
   error on any mismatch.
6. Repository CSV validation repeats the version, signature, completeness, and
   conformance checks. Browser tests verify both the working result and the
   fail-closed mismatch state.

Changing either workbook formula therefore requires the VBA contract, exported
version/signature, JavaScript formula, and tests to be updated in one release.
Changing only age factors, open standards, ages, or the active roster needs a
normal complete workbook export but no JavaScript change because those are data,
not calculation logic.

## Time entry

The calculator uses one paste-friendly duration field. It accepts `MM:SS`,
`H:MM:SS`, or compact digits such as `2430` and normalizes the value on blur.
Compact three- or four-digit values are read as `MMSS`; five- or six-digit values
are read as `HMMSS` or `HHMMSS`. An optional single decimal digit is retained as
tenths of a second, so `14530.5` becomes `1:45:30.5` and `14530` becomes
`1:45:30`. Results update immediately once the duration is valid and display
with Excel's `0.00%` precision.

## Release rule

Calculator CSVs are never copied selectively. They are added only through the
complete staged workbook bundle, validated with the manifest, reconciled against
tracked `data/`, and promoted as the whole bundle after explicit approval.

# TIN LAB Question Bank & Examination Security Specification

## 1. Data Invariants
1. Every document in `questionBankImports`, `questionBank`, `examTemplates`, and `publishedExamKeys` MUST be owned by an authenticated, email-verified user (`ownerUid == request.auth.uid` and `request.auth.token.email_verified == true`).
2. Legacy `questionBank` items (without `questionType`) remain valid as `multiple_choice` items without requiring destructive migration; new/updated items enforce format-specific required fields (`multiple_choice`: `optionA..D` + `answerKey`; `true_false`: `statementA..D` + boolean `statementAnswerA..D`; `essay`: non-empty `rubric`).
3. `examTemplates` MUST validate `recognitionPct + understandingPct + applicationPct == 100` and bounded positive duration/points.
4. `publishedExams` MUST NEVER expose plain-text `answerKey`, `statementAnswerA..D`, `rubric`, or `explanation`; creation MUST atomically pair with `publishedExamKeys/{examId}` (`existsAfter` / `getAfter`) owned by the same `ownerUid`. Only `status == 'published'` exams are readable/listable by non-owners.
5. `examSubmissions` MUST be created only by an authenticated, email-verified student (`studentUid == request.auth.uid`) referencing an existing `published` exam whose `ownerUid == teacherUid`. Only `teacherUid` may update essay scores, `gradingStatus`, or `teacherFeedback`.

## 2. Adversarial Payloads ("Dirty Dozen")
1. **Unauthenticated Write**: Create any entity with `request.auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: Create `questionBank` or `examTemplates` with `email_verified: false` -> `PERMISSION_DENIED`.
3. **Identity Spoofing**: Create `examTemplates` or `publishedExams` with `ownerUid: "other_teacher"` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection**: Create `questionBank` or `examTemplates` with extra key `isAdmin: true` -> `PERMISSION_DENIED`.
5. **Missing Answer Key / Rubric**: Create MCQ without `answerKey`, True/False without boolean `statementAnswerA..D`, or Essay without `rubric` -> `PERMISSION_DENIED`.
6. **Invalid Cognitive Sum**: Create `examTemplates` where `recognitionPct + understandingPct + applicationPct != 100` -> `PERMISSION_DENIED`.
7. **Orphaned Published Exam**: Create `publishedExams/{id}` without atomic `publishedExamKeys/{id}` -> `PERMISSION_DENIED`.
8. **Student Reading Private Keys**: Read `publishedExamKeys/{examId}` as a student (`uid != ownerUid`) -> `PERMISSION_DENIED`.
9. **Closed Exam Listing**: List `publishedExams` with `status == 'closed'` as a non-owner -> `PERMISSION_DENIED`.
10. **Student Self-Grading Tampering**: Update `part3FinalScore` or `totalScore` on `examSubmissions` as `studentUid` -> `PERMISSION_DENIED`.
11. **Forged Teacher UID on Submission**: Submit `examSubmissions` with `teacherUid` not matching `publishedExams/{examId}.ownerUid` -> `PERMISSION_DENIED`.
12. **Client Timestamp Forgery**: Create or update with backdated `createdAt`, `submittedAt`, or `reviewedAt` not equal to `request.time` -> `PERMISSION_DENIED`.

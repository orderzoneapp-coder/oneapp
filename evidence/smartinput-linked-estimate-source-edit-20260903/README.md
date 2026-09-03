# SmartInput 연동견적 원본별 수정 검증 증적

- 기준 SHA: `9a38a3c809ec8676c07d9232344a89663e817e59`
- 브랜치: `codex/smartinput-linked-estimate-source-edit-20260903`
- 상세 설계·구조 조사·검증: `docs/NEXUS_SMARTINPUT_LINKED_ESTIMATE_SOURCE_EDIT_20260903_01_WORK_RECORD.md`
- 대표 화면: `focused-browser/smartinput-linked-source-dialog-1440-light.png`

집중 브라우저 테스트는 1920/1440/390 각각 light/dark에서 dialog 경계, document/body overflow, 내부 scroll, footer 접근, 초기 focus, 다중 원본 무선택과 취소 0-write를 DOM/geometry assertion으로 검증한다. 캡처 안정성에 검증 강도를 의존하지 않으며 1440 light 대표 캡처 한 장만 남겼다.

테스트는 자신이 만든 임시 Chrome user-data-dir만 `finally`에서 종료·정리하며 다른 Chrome/profile은 건드리지 않는다.

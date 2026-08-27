# NEXUS 인증 게이트웨이 운영 기록

## 운영 배포

- 현재 운영 배포 계약: `NEXUS_AUTH_V2` (버전 19)
- 직전 운영 복구 버전: `NEXUS_AUTH_V2` (버전 17)
- Apps Script 프로젝트 ID: `1KNiTNpNRqPYM7XM5MSzGObwfUd303bZRcjgm16MVG3xNqcQpymYXaPI5`
- Web App 배포 ID: `AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i`
- Web App URL: `https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec`
- 현재 운영 배포 버전: `19`
- 실행 주체: 배포 소유자
- 접근 설정: 익명 포함 모든 사용자. 실제 보호는 모든 비공개 액션의 NEXUS 세션·권한 검사로 수행한다.

버전 7의 1회용 마스터 코드 회전 진입점은 버전 8에서 제거됐다. 버전 19는 기존 배포 ID를 유지한 채 Foundation B+ Local Primary 백업·버전 조회·관리자 복구 감사·장치 registry를 추가한다. 이 변경에 이상이 발생하면 같은 배포 ID를 버전 18로 복구한다.

## 최초 마스터

`nexusAuthPrepareBootstrap()`으로 발급한 등록 코드는 24시간 동안 한 번만 사용할 수 있다. 최초 등록이 끝나면 `OWNER_MASTER`는 다시 생성하거나 다른 사용자에게 부여할 수 없다.

`/nexus/admin/`의 `업무 연결`은 연결 상태만 표시하며 원문 서비스 자격증명을 입력하거나 조회하지 않는다. V2의 실제 자격증명 생성과 Script Properties 반영은 별도 승인된 운영 절차에서만 수행한다.

## 변경 배포

1. `nexus-auth-gateway.gs`와 Apps Script `Code.gs`가 동일한지 확인한다.
2. 새 불변 버전을 만든다.
3. 기존 배포 ID를 새 버전으로 갱신한다. 새 배포 ID를 만들지 않는다.
4. 배포 승인 후 `GET` health가 `NEXUS_AUTH_V2`와 `ready=true`를 반환하는지 확인한다.
5. 로그인·일반 사용자·마스터 관리·대표 DataOps/ORDER Q 요청을 확인한다.

프로젝트 소유자의 Google 권한은 스프레드시트와 외부 요청 두 범위만 사용한다. 사용자 비밀번호 원문과 업무 토큰을 로그나 저장소에 기록하지 않는다.

V2는 Foundation·DataOps·ORDER Q·Shipping의 READ/WRITE 8개 Script Property를 분리한다. ONEAPP 쪽은 각 경계의 `ONEAPP_NEXUS_GATEWAY_*_BINDINGS_JSON`에서 SHA-256 digest, `NEXUS_GATEWAY` actor, role, scope와 `ACTIVE` 또는 만료 전 `RETIRING` binding을 검증한다. `RETIRED`와 만료된 `RETIRING`은 인증을 거부한다. 실제 값은 상태·감사 응답에 포함하지 않는다. V1 proxy는 제거하지 않고 `LEGACY_V1`으로 별도 기록한다.

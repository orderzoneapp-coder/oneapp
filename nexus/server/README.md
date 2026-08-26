# NEXUS 인증 게이트웨이 운영 기록

## 운영 배포

- 계약: `NEXUS_AUTH_V1`
- Apps Script 프로젝트 ID: `1KNiTNpNRqPYM7XM5MSzGObwfUd303bZRcjgm16MVG3xNqcQpymYXaPI5`
- Web App 배포 ID: `AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i`
- Web App URL: `https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec`
- 최종 초기 배포 버전: `8`
- 실행 주체: 배포 소유자
- 접근 설정: 익명 포함 모든 사용자. 실제 보호는 모든 비공개 액션의 NEXUS 세션·권한 검사로 수행한다.

버전 7의 1회용 마스터 코드 회전 진입점은 버전 8에서 제거됐다. 운영 배포는 버전 8을 가리키며 저장된 현재 소스에도 해당 진입점이 없다.

## 최초 마스터

`nexusAuthPrepareBootstrap()`으로 발급한 등록 코드는 24시간 동안 한 번만 사용할 수 있다. 최초 등록이 끝나면 `OWNER_MASTER`는 다시 생성하거나 다른 사용자에게 부여할 수 없다.

마스터 등록 후 `/nexus/admin/`의 `업무 연결`에서 기존 ONEAPP 토큰을 한 번 등록한다. 값은 Apps Script `ScriptProperties`에만 저장되고 브라우저에는 연결 여부만 반환한다.

## 변경 배포

1. `nexus-auth-gateway.gs`와 Apps Script `Code.gs`가 동일한지 확인한다.
2. 새 불변 버전을 만든다.
3. 기존 배포 ID를 새 버전으로 갱신한다. 새 배포 ID를 만들지 않는다.
4. `GET` health가 `NEXUS_AUTH_V1`과 `ready=true`를 반환하는지 확인한다.
5. 로그인·일반 사용자·마스터 관리·대표 DataOps/ORDER Q 요청을 확인한다.

프로젝트 소유자의 Google 권한은 스프레드시트와 외부 요청 두 범위만 사용한다. 사용자 비밀번호 원문과 업무 토큰을 로그나 저장소에 기록하지 않는다.

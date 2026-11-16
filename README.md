# 꼭꼭 Research PoC

2026-11-11 이전. 앱과 분석 기록·비교 실험·보고서를 함께 보관합니다.

```powershell
cd C:\KKokKKok\KkokKkok-Research-PoC
.\start.ps1
```

브라우저: http://127.0.0.1:3210

- location-cue-lab: 앱 소스·테스트·private-data/cues.sqlite·분석 이미지
- photo-batch: 사진별 추출 JSON·중간 보고서
- location-experiment-pilot: 위치 비교 실험 입력·원응답·채점 현황
- location-cue-lab/LOCATION-EXPERIMENT.md: 비교 실험 실행 지침

기존 C:\KKokKKok\KkokKkok-PoC의 Node 패키지·Python 환경·모델 캐시·환경설정을 읽어 사용하므로 기존 폴더도 유지해야 합니다. 2026-11-11에 기존 `.env.local`의 설정(API 키 포함)을 `location-cue-lab\.env`로 복사했습니다. 이 파일이 기존 `.env.local`보다 우선하므로, 키를 바꿀 때는 `location-cue-lab\.env`를 고쳐야 합니다.

기존 작업 공간의 보고서·실험 산출물 사본은 보관하며 새 실행은 이 폴더를 기준으로 합니다. 기록에 남아 있는 과거 절대 경로는 실행 당시 출처 정보입니다.

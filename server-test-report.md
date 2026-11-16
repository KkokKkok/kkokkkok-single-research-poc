# 서버 점검 결과

- 서버: http://127.0.0.1:3210 (유지 중인 실행 세션 66867)
- 실행 위치: C:\KKokKKok\KkokKkok-Research-PoC\location-cue-lab
- 화면 HTML·JavaScript·CSS HTTP 200
- 기존 기록 13건 조회 (completed 11, partial 2)
- 완료 기록 상세·이미지·JSON export HTTP 200
- OCR 및 Grounding Python 경로 존재 확인; 이번 점검에서 실제 OCR/DINO 추론은 재실행하지 않음
- OpenAI 모델 gpt-5.4-mini 소규모 Responses 요청: HTTP 401, code token_invalidated
- 실제 사용 키 출처: C:\KKokKKok\KkokKkok-PoC\.env.local 의 OPENAI_API_KEY
- 상속 환경변수나 새 PoC의 .env 키에 의해 덮어쓰인 상태가 아님
- 인증 실패로 신규 사진 전체 분석은 수행하지 않음. 만료·폐기 등 무효화 원인의 세부 사유는 응답만으로 확인할 수 없음.
- 유효한 키를 새 PoC의 .env에 OPENAI_API_KEY로 설정하고 서버 재시작 후 재검증 필요

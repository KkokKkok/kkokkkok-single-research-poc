# 글자 단서 다시 읽기 사진 모음

OCR이 찾지 못한 글자 단서를, 모델이 짚은 자리를 잘라 확대하고 기울기를 편 뒤 다시 읽은 결과의 사진을 모두 모았습니다. 방법과 수치의 설명은 [paper-alignment-changes.md](paper-alignment-changes.md)의 2026-11-16 작업 18에 있습니다.

## 2026-11-16

### 요약

| | 값 |
|---|---|
| 사진 | 34장 (집_당산 8 확인 4장, 단서별 30장) |
| 다시 읽은 단서 | 30개 (사진 26장에서) |
| 연결됨 | 10개 (그림으로 확인 9개, 의심 1개: 20번) |
| 모델 상자로 대체 (OCR 확인 안 됨) | 17개 |
| 상자 없음 (모델이 위치를 못 짚음) | 3개 |

그림 보는 법:

- **노란 점선**: 모델(대역)이 글자가 있다고 짚은 자리
- **초록 상자**: 그 주변을 다시 읽은 OCR이 인용 글자와 맞는 줄을 찾은 자리 (`verified: true`)
- **주황 상자**: OCR이 끝까지 못 읽어서 모델이 짚은 상자를 그대로 단서의 영역으로 쓴 것 (`verified: false`). 도구가 확인한 위치가 아닙니다
- 머리띠가 초록이면 연결됨, 주황이면 모델 상자로 대체, 빨강이면 상자 없음
- 그림에 보이는 범위가 실제로 잘라서 OCR에 넣은 범위입니다

위치 힌트는 실제 API가 아니라 파일 전달 방식의 대역(`claude-fable-5-2`)이 냈고, OCR은 로컬 PaddleOCR입니다. 실행 기록은 바꾸지 않았습니다.

### 한눈에 보기

| # | 사진·단서 | 인용 글자 | 다시 읽은 글자 (마지막 시도) | 결과 |
|---|---|---|---|---|
| 01 | 집_합정 4 clue-2 | `HEIGHTS-STORE.COM` | NEIGNTS-STORECOM | 연결됨 |
| 02 | 집_합정 4 clue-0 | `eTeket.com` | Teketce | 연결됨 |
| 03 | 학교 4 clue-0 | `CAU` | 88 / C | 모델 상자로 대체 |
| 04 | 회사_가산디지털단지 2 clue-4 | `244-0807` | 단체예약 / 2APE7T | 모델 상자로 대체 |
| 05 | 집_합정 1 clue-7 | `ODAH` | ODAH | 연결됨 |
| 06 | 학교 40 clue-1 | `CAU` | (없음) | 모델 상자로 대체 |
| 07 | 이전 사진 12 clue-4 | `CAU` | (없음) | 모델 상자로 대체 |
| 08 | 이전 사진 2 clue-4 | `Puang` | — | 상자 없음 |
| 09 | 회사_충무로 17 clue-0 | `마전교` | 빠랜고 | 모델 상자로 대체 |
| 10 | 집_합정 15 clue-2 | `사아빌딩` | OE / 보드AOT | 모델 상자로 대체 |
| 11 | 회사_충무로 7 clue-2 | `영동` | 동방 / 8구 | 모델 상자로 대체 |
| 12 | 이전 사진 10 clue-5 | `102` | ICL | 모델 상자로 대체 |
| 13 | 회사_충무로 16 clue-1 | `CJ HUMANVILLE` | JHUMANVIL | 연결됨 |
| 14 | 회사_가산디지털단지 4 clue-5 | `Ngoi Sao` | NgdISao | 연결됨 |
| 15 | 집_합정 2 clue-6 | `and` | — | 상자 없음 |
| 16 | 학교 11 clue-1 | `Puang` | — | 상자 없음 |
| 17 | 이전 사진 8 clue-2 | `S25` | $?5 | 모델 상자로 대체 |
| 18 | 이전 사진 8 clue-3 | `TWOSOME` | M | 모델 상자로 대체 |
| 19 | 이전 사진 8 clue-4 | `PREMIUM STUDY CAFE` | CR / A / 0KM0 | 모델 상자로 대체 |
| 20 | 집_금천구 5 clue-2 | `STUDY CAFE, 꿈., ...COUNT` | 꿈 | 연결됨 |
| 21 | 집_당산 4 clue-1 | `Phở ông Nam 24` | Nam | 연결됨 |
| 22 | 집_금천구 1 clue-1 | `TWOSOME` | FWoa / 정도면 / 이 | 모델 상자로 대체 |
| 23 | 집_금천구 1 clue-12 | `RT` | (없음) | 모델 상자로 대체 |
| 24 | 집_합정 24 clue-2 | `2026 GSC 커피마스터 챔피언십 우승 피오커피 최원석` | 2026 GSG커피마스터 챔피언십, 피오커피조원석 | 연결됨 |
| 25 | 집_합정 6 clue-4 | `N메디` | 통중N메디 | 연결됨 |
| 26 | 집_합정 7 clue-5 | `BLACK FRIDAY, 02-332` | 02-882 (다른 각도에서는 02-382) | 모델 상자로 대체 |
| 27 | 회사_충무로 19 clue-3 | `villa` | (없음) | 모델 상자로 대체 |
| 28 | 집_금천구 7 clue-2 | `LOTTE CAS...` | LGTAELA | 모델 상자로 대체 |
| 29 | 학교 6 clue-2 | `응급의료센터` | 등급의료센터 | 연결됨 |
| 30 | 집_당산 18 clue-6 | `30` | (없음) | 모델 상자로 대체 |

### 1. 출발점: 집_당산 8 "학교법인 일송학원" (4장)

#### ① OCR 검출 상자 전체

검출 상자 73개 중 간판 자리(노란 점선)와 겹치는 것이 0개입니다. 초록은 읽은 줄, 빨강은 검출만 되고 못 읽은 자리입니다.

![집_당산 8 검출 상자 전체](paper-text-recheck-images/dangsan8-1-detector-boxes.jpg)

#### ② 발음이 비슷하게 읽힌 줄

자모 단위로 가장 비슷한 줄이 `마이일?`(0.57)이고 모두 꽃집 입간판의 글자입니다. 간판을 잘못 읽은 줄은 없습니다.

![집_당산 8 발음이 비슷한 줄](paper-text-recheck-images/dangsan8-2-similar-sound.jpg)

#### ③ 대역이 읽은 자리와 가장 가까운 OCR 상자

가장 가까운 상자는 `wedding/plant`이고 간판에서 286px 떨어진 다른 간판입니다.

![집_당산 8 가장 가까운 상자](paper-text-recheck-images/dangsan8-3-nearest-to-reading.jpg)

#### ④ 짚은 자리만 잘라 확대·회전 후 OCR

`화교법인일송회원`으로 읽고 상자가 간판 위에 잡힙니다. 아래쪽은 자른 범위를 확대한 것입니다.

![집_당산 8 잘라서 다시 읽기](paper-text-recheck-images/dangsan8-4-crop-enlarge-ocr.jpg)

### 2. 연결된 단서 (10장)

#### 01. 집_합정 4 clue-2 — 연결됨

- 인용 글자: `HEIGHTS-STORE.COM`
- 다시 읽은 글자: NEIGNTS-STORECOM
- 비고: 세로로 쓰인 글자

![집_합정 4 clue-2](paper-text-recheck-images/01-linked.jpg)

#### 02. 집_합정 4 clue-0 — 연결됨

- 인용 글자: `eTeket.com`
- 다시 읽은 글자: Teketce

![집_합정 4 clue-0](paper-text-recheck-images/02-linked.jpg)

#### 05. 집_합정 1 clue-7 — 연결됨

- 인용 글자: `ODAH`
- 다시 읽은 글자: ODAH

![집_합정 1 clue-7](paper-text-recheck-images/05-linked.jpg)

#### 13. 회사_충무로 16 clue-1 — 연결됨

- 인용 글자: `CJ HUMANVILLE`
- 다시 읽은 글자: JHUMANVIL

![회사_충무로 16 clue-1](paper-text-recheck-images/13-linked.jpg)

#### 14. 회사_가산디지털단지 4 clue-5 — 연결됨

- 인용 글자: `Ngoi Sao`
- 다시 읽은 글자: NgdISao

![회사_가산디지털단지 4 clue-5](paper-text-recheck-images/14-linked.jpg)

#### 20. 집_금천구 5 clue-2 — 연결됨

- 인용 글자: `STUDY CAFE, 꿈., ...COUNT`
- 다시 읽은 글자: 꿈
- 비고: **의심**: 연결된 상자가 그림 범위 밖

![집_금천구 5 clue-2](paper-text-recheck-images/20-linked.jpg)

#### 21. 집_당산 4 clue-1 — 연결됨

- 인용 글자: `Phở ông Nam 24`
- 다시 읽은 글자: Nam
- 비고: 인용 글자의 일부만

![집_당산 4 clue-1](paper-text-recheck-images/21-linked.jpg)

#### 24. 집_합정 24 clue-2 — 연결됨

- 인용 글자: `2026 GSC 커피마스터 챔피언십 우승 피오커피 최원석`
- 다시 읽은 글자: 2026 GSG커피마스터 챔피언십, 피오커피조원석
- 비고: 두 줄

![집_합정 24 clue-2](paper-text-recheck-images/24-linked.jpg)

#### 25. 집_합정 6 clue-4 — 연결됨

- 인용 글자: `N메디`
- 다시 읽은 글자: 통중N메디

![집_합정 6 clue-4](paper-text-recheck-images/25-linked.jpg)

#### 29. 학교 6 clue-2 — 연결됨

- 인용 글자: `응급의료센터`
- 다시 읽은 글자: 등급의료센터
- 비고: 이번 완화로 통과

![학교 6 clue-2](paper-text-recheck-images/29-linked.jpg)

### 3. 모델 상자로 대체한 단서 (17장)

OCR이 인용 글자를 다시 읽지 못해 모델이 짚은 상자(주황)를 영역으로 씁니다. 이 17장 중 12번과 28번만 열어 보았고 둘 다 상자가 맞는 글자 위에 있었습니다. 나머지는 상자가 맞는지 확인하지 않았습니다.

#### 03. 학교 4 clue-0 — 모델 상자로 대체

- 인용 글자: `CAU`
- 다시 읽은 글자: 88 / C
- 비고: 붓글씨 로고

![학교 4 clue-0](paper-text-recheck-images/03-fallback.jpg)

#### 04. 회사_가산디지털단지 2 clue-4 — 모델 상자로 대체

- 인용 글자: `244-0807`
- 다시 읽은 글자: 단체예약 / 2APE7T
- 비고: 숫자

![회사_가산디지털단지 2 clue-4](paper-text-recheck-images/04-fallback.jpg)

#### 06. 학교 40 clue-1 — 모델 상자로 대체

- 인용 글자: `CAU`
- 다시 읽은 글자: (없음)
- 비고: 붓글씨 로고

![학교 40 clue-1](paper-text-recheck-images/06-fallback.jpg)

#### 07. 이전 사진 12 clue-4 — 모델 상자로 대체

- 인용 글자: `CAU`
- 다시 읽은 글자: (없음)
- 비고: 로고

![이전 사진 12 clue-4](paper-text-recheck-images/07-fallback.jpg)

#### 09. 회사_충무로 17 clue-0 — 모델 상자로 대체

- 인용 글자: `마전교`
- 다시 읽은 글자: 빠랜고
- 비고: 흐림

![회사_충무로 17 clue-0](paper-text-recheck-images/09-fallback.jpg)

#### 10. 집_합정 15 clue-2 — 모델 상자로 대체

- 인용 글자: `사아빌딩`
- 다시 읽은 글자: OE / 보드AOT
- 비고: 흐림

![집_합정 15 clue-2](paper-text-recheck-images/10-fallback.jpg)

#### 11. 회사_충무로 7 clue-2 — 모델 상자로 대체

- 인용 글자: `영동`
- 다시 읽은 글자: 동방 / 8구
- 비고: 두 글자

![회사_충무로 7 clue-2](paper-text-recheck-images/11-fallback.jpg)

#### 12. 이전 사진 10 clue-5 — 모델 상자로 대체

- 인용 글자: `102`
- 다시 읽은 글자: ICL
- 비고: 숫자

![이전 사진 10 clue-5](paper-text-recheck-images/12-fallback.jpg)

#### 17. 이전 사진 8 clue-2 — 모델 상자로 대체

- 인용 글자: `S25`
- 다시 읽은 글자: $?5
- 비고: 짧은 글자

![이전 사진 8 clue-2](paper-text-recheck-images/17-fallback.jpg)

#### 18. 이전 사진 8 clue-3 — 모델 상자로 대체

- 인용 글자: `TWOSOME`
- 다시 읽은 글자: M
- 비고: 로고

![이전 사진 8 clue-3](paper-text-recheck-images/18-fallback.jpg)

#### 19. 이전 사진 8 clue-4 — 모델 상자로 대체

- 인용 글자: `PREMIUM STUDY CAFE`
- 다시 읽은 글자: CR / A / 0KM0
- 비고: 흐림

![이전 사진 8 clue-4](paper-text-recheck-images/19-fallback.jpg)

#### 22. 집_금천구 1 clue-1 — 모델 상자로 대체

- 인용 글자: `TWOSOME`
- 다시 읽은 글자: FWoa / 정도면 / 이
- 비고: 로고

![집_금천구 1 clue-1](paper-text-recheck-images/22-fallback.jpg)

#### 23. 집_금천구 1 clue-12 — 모델 상자로 대체

- 인용 글자: `RT`
- 다시 읽은 글자: (없음)
- 비고: 큰 로고 글자

![집_금천구 1 clue-12](paper-text-recheck-images/23-fallback.jpg)

#### 26. 집_합정 7 clue-5 — 모델 상자로 대체

- 인용 글자: `BLACK FRIDAY, 02-332`
- 다시 읽은 글자: 02-882 (다른 각도에서는 02-382)
- 비고: 숫자 한 글자 차이

![집_합정 7 clue-5](paper-text-recheck-images/26-fallback.jpg)

#### 27. 회사_충무로 19 clue-3 — 모델 상자로 대체

- 인용 글자: `villa`
- 다시 읽은 글자: (없음)

![회사_충무로 19 clue-3](paper-text-recheck-images/27-fallback.jpg)

#### 28. 집_금천구 7 clue-2 — 모델 상자로 대체

- 인용 글자: `LOTTE CAS...`
- 다시 읽은 글자: LGTAELA
- 비고: 흐림

![집_금천구 7 clue-2](paper-text-recheck-images/28-fallback.jpg)

#### 30. 집_당산 18 clue-6 — 모델 상자로 대체

- 인용 글자: `30`
- 다시 읽은 글자: (없음)
- 비고: 숫자

![집_당산 18 clue-6](paper-text-recheck-images/30-fallback.jpg)

### 4. 상자가 없는 단서 (3장)

모델이 위치를 짚지 못해 대체할 상자도 없습니다. 사진 전체를 보여 줍니다.

#### 08. 이전 사진 2 clue-4 — 상자 없음

- 인용 글자: `Puang`
- 모델이 위치를 못 짚어 다시 읽지 않음
- 비고: 모델이 위치를 못 짚음

![이전 사진 2 clue-4](paper-text-recheck-images/08-nohint.jpg)

#### 15. 집_합정 2 clue-6 — 상자 없음

- 인용 글자: `and`
- 모델이 위치를 못 짚어 다시 읽지 않음
- 비고: 모델이 위치를 못 짚음

![집_합정 2 clue-6](paper-text-recheck-images/15-nohint.jpg)

#### 16. 학교 11 clue-1 — 상자 없음

- 인용 글자: `Puang`
- 모델이 위치를 못 짚어 다시 읽지 않음
- 비고: 모델이 위치를 못 짚음

![학교 11 clue-1](paper-text-recheck-images/16-nohint.jpg)

# 기존 꼭꼭 PoC와 Research Cue Lab 비교 보고서

작성일: 2026-11-10  
비교 대상: 기존 `C:\KKokKKok\KkokKkok-PoC`와 신규 `outputs/location-cue-lab`의 현재 로컬 코드  
목표: 사진 한 장에서 위치 추적에 이용될 만한 문자·비문자 단서를 추출하고, DB 저장 가능한 JSON과 이미지 영역을 연결한다.

## 1. 핵심 판단

새 PoC의 가장 큰 변화는 **고정된 객체·속성 체계 중심의 비문자 관찰을, 자유 범주로 문자·비문자를 함께 발견하는 방식으로 바꾼 것**이다. 발견 후보를 기준으로 영역을 탐지하고, 공통 `cues[]` 구조로 출력한다.

OCR, Grounding DINO, crop 검토, SQLite 저장, 원본과 사람 검토의 분리, 실패 후 재시도는 기존 PoC에도 있었다. 따라서 이 기능들을 새로 도입한 것이 개선의 핵심이라고 설명하면 부정확하다. 기존의 기반을 활용하면서 발견 범위와 결과 표현을 바꾼 별도 실험 구현이다.

새 PoC가 기존 PoC보다 정확하다는 결론은 아직 낼 수 없다. 제공된 사진으로 신규 파이프라인이 작동하는 것은 확인했지만, 동일한 정답·사진 집합으로 기존 버전과 비교한 실험은 하지 않았다. 특히 새 버전은 기존의 세밀한 속성 계약과 서버 규칙 일부를 단순화했다. **개방형 발견에는 유리한 구조이나, 의미 판정의 일관성과 기존 서비스 연동에서는 보완할 부분이 있다.**

## 2. 요구사항별 비교

| 항목 | 기존 PoC | 새 Research Cue Lab | 의미 |
|---|---|---|---|
| 초기 발견 | 비문자 관찰 전용 VLM | 문자·비문자 동시 발견 VLM, 이후 독립 OCR | OCR이 놓친 문자 후보도 발견 결과로 남길 수 있으나 두 출처의 중복·판독 충돌이 생김 |
| 범주·객체 | 고정 category/objectType/속성 enum, 한국어 이름은 자유 | category와 객체 설명은 자유 문자열 | 미등록 대상 표현은 쉬워지지만 범주명 통일은 약해짐 |
| 개수 제한 | 초기 관찰 최대 12개 | 초기 발견 기술적 상한 80개, coverageLimited | 후보 공간을 넓힘. 실제로 80개를 찾거나 누락이 없어지는 것은 아님 |
| 속성 표현 | attributes, attributeEvidence, quality, parentIndex 등 구조화 | observationKo, limitationsKo 등 서술 중심 | 유연성 증가, 속성별 검색·집계·검증은 약화 |
| 문자 검토 | 전체 이미지·OCR polygon과 lineChecks, 같은 식별자 조각 묶음 | 전체 이미지와 ID별 문맥 crop, 8개씩 검토, 원칙적으로 1 ID당 1 관찰 | 개별 영역 대응을 확인하기 쉬우나 분절된 상호·주소 재조합은 약함 |
| 문자 관련성 판정 | 표면·판독·정보 유형을 모델이 판단하고 서버가 규칙 적용 | 모델이 candidate/uncertain/irrelevant를 직접 출력 | 새 버전은 프롬프트 준수에 더 의존 |
| DINO 탐지 | 기본 공통 질의 + 후보별 보충 질의 + 외벽 내부 crop 탐지 | 발견 후보의 detectorQueryEn을 질의별 실행하고 cueId로 연결 | 탐지 기준을 발견 후보에 맞춤. 초기 발견 누락은 그대로 전파될 수 있음 |
| 영역 검증 | 검출 crop별 모델 검토·후보 연결 | 단서별 후보 영역에 전체 문맥과 crop을 함께 제시 | 반사·배치 문맥을 쓸 수 있으나 crop 밖 근거를 잘못 차용할 위험도 있음 |
| 결과 JSON | analysis, fusion, objectFusion 등 단계별 구조 | 원본 artifacts와 공통 cues[]를 분리 | 후속 소비자가 단서 목록을 한 경로에서 읽기 쉬움 |
| 저장 | SQLite discovery_records의 record_json | SQLite analyses의 record_json | DB 종류가 바뀐 것이 아니라 문서 계약과 테이블이 바뀜 |
| 위험도 | OCR·객체 검토의 규칙 기반 단독 등급; 초기 비문자 관찰은 modelRisk:null | 위험도 등급 없음, 지리적 관련성 설명과 geoSpecificityVerified:false | 발견·영역 대응에 집중. 기존 등급 소비자와 호환되지 않음 |
| 사람 검토 | 후보·OCR·객체 등 별도 검토와 완료 조건 | 단서별 상태·메모·선택적 bbox 저장 | 검토 기능은 유지하되 실험 운영 기능은 단순화 |
| 중단 복구 | 단계별 및 객체 crop별 완료 결과 재사용 | 단계별·OCR 배치별·단서 검증별 결과 재사용 | 둘 다 지원. 체크포인트 단위가 다름 |
| 앱 구조 | Next.js/React/TypeScript | Node HTTP + 기본 HTML/CSS/JavaScript | 새 파이프라인을 독립 실험하기 쉬우나 기존 제품 통합은 별도 |
| Spring 연동 | 검사 접수·조회와 결과 변환 코드 존재 | 새 로컬 분석 API만 제공 | 기존 API의 대체 구현이 아님 |
| SAM | 이번 비교 대상의 주 분석 경로는 OCR·DINO bbox 기반 | mask:null, SAM 미구현 | 새 버전도 bbox 경로까지만 완료 |

근거 파일은 10절에 연결했다. 이 표는 현재 코드 비교이며 기존 버전 전체 이력이나 모든 prototype 실험을 평가한 것은 아니다.

## 3. 처리 흐름의 변화

### 기존 PoC

```text
분석 이미지
 ├─ 비문자 VLM: 고정 계약, 최대 12개 ─┬─ OCR Fusion
 ├─ PaddleOCR ──────────────────────┘
 └─ 공통 질의 DINO ── 후보별 보충 탐지 ── crop별 Object Fusion
                     ↓
          단계별 결과 + 서버 규칙 평가 + 사람 검토
                     ↓
               SQLite / 검사 결과 API
```

초기 VLM·OCR·DINO는 병렬 실행한다. OCR Fusion은 VLM과 OCR, Object Fusion은 VLM과 DINO가 준비된 후 실행한다. 보충 탐지는 후보 질의 중 최대 4개를 실행하고, 외벽 안의 창문·프레임을 추가 탐지하는 특수 경로가 있다. 객체 crop 검토는 실행당 최대 12회 호출하고 완료 결과를 보존해 이어갈 수 있다. 이 12회 제한은 초기 관찰 12개 제한과 다른 제한이다.

### 새 PoC

```text
분석 이미지
 → 문자·비문자 개방형 발견
 → PaddleOCR
 → OCR ID별 문맥 crop 검토: 배치당 8개
 → 발견 후보별 DINO 질의
 → 단서와 후보 영역의 대응 검토
 → 공통 cues[] 생성 + 원본 artifacts 보존
 → SQLite / JSON 내보내기 / 사람 검토
```

현재 구현은 주요 단계를 순차 실행한다. DINO는 발견한 후보의 질의를 사용하고 질의마다 cueId를 유지한다. 모델을 한 번 로드해 여러 질의를 처리하지만 전체 처리시간이나 비용이 기존보다 줄었다는 측정 결과는 없다. 후보와 검증 영역이 많아지면 호출량이 늘 수 있다.

기존의 공통 질의 탐지는 초기 VLM이 놓친 대상을 독립적으로 찾을 여지가 있다. 새 버전은 후보 중심 연결이 명확한 대신 **초기 발견에서 빠진 비문자 대상을 DINO가 독립적으로 보충하는 일반 경로가 없다.** 발견 범위를 넓혔다는 사실과 누락을 복구한다는 사실은 구분해야 한다.

## 4. 논문과 프롬프트를 어떻게 이식했는가

### DoxBench

기존 초기 프롬프트도 간접 단서를 유지하고 실제 위치를 추론하지 않도록 했다. 차이는 한국어 이름의 자유 여부보다, 최종적으로 고정 objectType·속성 enum에 맞춰야 하는지에 있다.

새 발견 프롬프트는 앞선 소스 분석에서 확인한 GeoMiner의 범주 발견 방식을 참고해 다음을 요청한다.

- 이미지 세부를 관찰한 뒤 자유 범주와 구체적인 단서를 기록한다.
- 전경·배경·가장자리·창문·반사면을 살핀다.
- 흔한 건축·시설물·식생도 구체적인 관찰 내용이 있으면 후보로 남긴다.
- 실제 주소·도시·좌표, 확인하지 않은 랜드마크 이름, 위험 확률은 생성하지 않는다.
- bbox는 생성하지 않고 탐지할 물리적 대상을 영어 질의로 표현한다.

이는 논문 프롬프트의 원문 재현이 아니다. JSON Schema, 한국어 설명, 표면 구분, 불확실성, detectorQueryEn 등은 사용자 요구사항을 위해 추가했다.

### Beyond the Geotag

첨부 코드의 Text Value 관점인 일반 문구·공유 브랜드·지역/연락 식별자·구체적 장소 문자열의 차이를 새 OCR 프롬프트에 반영했다. 원문의 0/3/7/10 점수나 State 매핑, 베이지안 네트워크의 해결 확률은 이식하지 않았다.

이 구분 자체가 기존에 없던 것은 아니다. 기존 `ocr-cue-policy.ts`에는 이미 주소·지점·브랜드·일반 안내·일상 자막 등의 정보 유형과 서버 판정 규칙이 있었다. 새 버전의 추가점은 문맥 crop 기반 검토와 개방형 후보 구조이며, 관련성 판정의 규칙성은 오히려 기존 쪽이 더 명시적이다.

### 중요한 차이: 제외 기준의 집행 위치

| 사례 | 기존 정책 | 새 정책 | 평가 |
|---|---|---|---|
| 일반 영업시간·가격 | 모델이 generic_notice로 판단하면 서버가 not_useful 적용 | 프롬프트가 irrelevant를 요청하고 모델이 직접 판정 | 새 버전은 모델이 제외 지침을 무시할 수 있음 |
| 일상적인 합성 자막 | overlay/generic_caption 등을 구조적으로 구분 | depicted와 관련성 설명에 의존 | 새 surface 체계는 overlay와 depicted text를 구별하지 않음 |
| 차량 광고의 주소 | moving_object와 portable_context 규칙 | movable과 프롬프트 설명 | 양쪽 모두 촬영 위치로 확정하면 안 됨 |

기존 역시 모델이 정보 유형이나 표면을 잘못 고르면 오판할 수 있다. 다만 관찰 판단 이후의 서버 규칙은 결정적이다. **다음 통합에서 우선 복원할 부분은 기존의 OCR 정보 유형·서버 판정 계층이다.**

## 5. JSON과 DB 계약의 차이

### 기존: 단계별 결과를 모은 실험 기록

`analysis.modelOutput.candidates`, `ocr`, `fusion`, `grounding`, `objectFusion`과 각 사람 검토가 분리되어 있다. 속성별 시각 근거·품질·부모 관계와 검토 완료 조건을 표현하는 데 강점이 있다. 소비자는 여러 단계의 결과와 연결 관계를 이해해야 한다.

### 신규: 원본에서 공통 단서 목록을 생성

`artifacts`는 단계별 원본, `cues[]`는 화면·후속 서비스용 파생 결과다. 주요 필드는 다음과 같다.

| 필드 | 의미 | 해석 주의 |
|---|---|---|
| kind | text / non_text | 서로 다른 출처가 같은 물리적 단서를 기록할 수 있음 |
| category, observationKo | 자유 범주와 보이는 내용 | 범주명이 정규화된 분류 코드가 아님 |
| source | 발견 VLM 또는 OCR 검토 | 출처 보존용 |
| disposition | candidate / uncertain / irrelevant | 초기 발견 관찰은 서버가 candidate로 설정; 모든 관찰이 독립 관련성 심사를 통과했다는 뜻은 아님 |
| surface | fixed / movable / reflection / depicted / unknown | 물리적 출처에 대한 모델 판단 |
| geographicRelevanceKo | 위치 대조에 쓰일 가능성 설명 | 실제 고유성을 검증한 결과가 아님 |
| evidenceGroupIds | OCR과 독립 발견의 연결 후보 | 중복 제거 완료나 독립 증거 묶음을 보장하지 않음 |
| localization.proposals | OCR·DINO 영역과 판정 | 여러 제안과 불일치도 보존 |
| localization.status | supported / partial / rejected / proposed / not_assessed / unlocalized | 영역 대응의 상태이며 위치 위험도가 아님 |
| geoSpecificityVerified | 현재 false | 실제 지역 고유성을 확인하지 않음 |
| humanReviews | 사람 상태·메모·수정 bbox | 모델 원본을 덮어쓰지 않음 |

`supported`는 적어도 하나의 영역 제안이 지지되면 집계된다. 같은 단서의 다른 영역 제안은 여전히 거절·부분 확인일 수 있으므로 세부 proposals를 확인해야 한다. 관련성이 없어서 별도 영역 검토를 하지 않은 OCR은 `not_assessed`로 남긴다.

두 시스템 모두 SQLite에 JSON 문서를 저장한다. 새 버전은 `schemaVersion: location-cues-v1`, 기존은 기존 DiscoveryRecord 계약을 사용한다. 테이블 이름과 문서 구조가 달라 DB 파일 교체나 기존 결과 덮어쓰기로 이전하면 안 된다. 단계별 모델 출력 검증은 새 버전에도 있지만, 기존 `discoveryRecordSchema` 수준의 전체 기록·검토 완료 조건 검증을 그대로 이식한 것은 아니다. 새 Store는 JSON 저장 중심이므로 장기 운영용 계약 검증은 추가할 필요가 있다.

## 6. 실제 사진에서 확인한 결과와 확인하지 못한 것

사용자가 제공한 `KakaoTalk_20261101_221748649_09.jpg`를 사용했다. 기존 시스템과 동일 조건의 재실행 비교는 하지 않았다.

| 측정 항목 | 신규 결과 |
|---|---:|
| 초기 발견 | 문자 4개 + 비문자 6개 |
| OCR 원본 영역 | 33개 |
| 전체 보존 관찰 | 43개 |
| 영역 상태 supported | 14개 |
| 관련성 판정 | 후보 28 / 보류 2 / 무관 13 |
| 파이프라인 상태 | completed, errors 없음 |

비문자 후보에는 흰 외벽과 유리면, 차양, 반사 나무, 펜던트 조명, 소화기, 바닥 배수·마감 경계가 포함됐다. 이들이 관찰되고 영역과 연결된 것은 확인했지만 실제 지리적 식별력을 검증하지는 않았다.

43개는 중복 OCR과 같은 표지에 대한 독립 관찰을 포함한다. 14/43을 정확도로 계산할 수 없다. 기존 결과와의 정답 기반 비교가 없으므로 “검출량 증가”, “재현율 개선”, “정확도 상승”은 현재 증거로 주장할 수 없다.

남은 문제는 다음과 같다.

- 덧붙인 “새로운 카페 와보기” 자막을 물리적 표지처럼 해석한 사례.
- 일반 메뉴명·영업시간을 위치 후보로 과대평가한 사례.
- 영업시간에서 VLM과 OCR의 판독이 충돌한 사례.
- 출입문 포스터의 후보 영역이 오른쪽 메뉴판을 가리켜 부분 확인으로 남은 사례.

자동 테스트 10개와 JavaScript 구문 검사는 기능·계약 검증이다. 추출 정확도 검증을 대신하지 않는다. 사진 분석 결과, UI의 bbox 대응, JSON 다운로드와 저장 결과의 일치는 별도로 확인했다.

## 7. 유지한 기능과 이식하지 않은 기능

| 분류 | 내용 |
|---|---|
| 유지·재사용 | PaddleOCR 기반 문자 영역 추출, Grounding DINO, 기존 설치 환경·모델 캐시, 서버 측 API 키, 분석 이미지, 정규화 좌표, 원본/사람 검토 분리 |
| 새 방식으로 구현 | 개방형 문자·비문자 발견, 공통 cues[], 후보별 DINO 처리, 문맥 OCR crop 배치 검토, 상태별 화면 표시 |
| 단순화 | 상세 객체 속성 계약, 부모·부분의 명시적 연결, 검토 완료 규칙, 위험도/정보 유형 정책, 전체 기록 스키마 |
| 이식하지 않음 | 기존 Spring 검사 API, 기존 상세 실험 기록·검토 흐름 전체, 외벽 내부 재탐지 특수 경로 |
| 새 버전에도 없음 | SAM mask, 실제 위치 추론, 지리적 고유성 검증, 논문 베이지안 위험 확률 |

기존 앱의 소스·DB·기록을 변경하지 않고 별도 폴더에 구현했다. 다만 이 PC에서는 기존 설치 패키지·Python 환경·설정을 명시적으로 재사용하므로 완전히 독립된 배포 패키지라는 뜻은 아니다. 다른 PC에서는 README의 의존성 설치와 환경 설정이 필요하다.

## 8. 기존 PoC에 다시 적용할 때의 권고

현재 결과만으로 기존 앱 전체를 새 앱으로 교체하는 것보다, **새 개방형 발견과 공통 단서 표현을 기존 검증·정책·서비스 계층에 연결하는 방식**이 적절하다. 아래는 후속 권고이며 이번 보고서 작성에서 구현한 변경이 아니다.

| 우선순위 | 후속 작업 | 이유 |
|---|---|---|
| 1 | 개방형 발견은 유지하면서 기존 OCR 정보 유형·surface·서버 판정 규칙 복원 | 일반 메뉴·자막의 후보 과다 채택을 줄이기 위한 명시적 통제 |
| 1 | 발견·가시성·영역 대응·지리적 관련성을 별도 판정으로 저장 | supported를 유용성 확정으로 오해하지 않도록 함 |
| 1 | 공통 cues[]에 전체 저장 스키마·참조 무결성 검증 추가 | 서비스 연동 시 잘못된 파생 결과 저장 방지 |
| 2 | 같은 물리적 식별자의 OCR 조각·대체 판독·중복 관찰 연결 | 잘린 상호·주소 복원 및 중복 집계 방지; 원문은 유지 |
| 2 | 자유 서술에 선택적 구조화 속성·부모 관계를 병행 | 개방성을 유지하면서 비교·검색 기능 회복 |
| 2 | 초기 발견 누락을 보완하는 독립 탐지 경로 실험 | 후보 중심 DINO의 누락 전파 완화 |
| 2 | 기존 검사 API에 새 결과를 변환하는 명시적 어댑터 추가 | 기존 클라이언트 계약 유지; 위험도 없는 값을 임의 생성하지 않기 |
| 3 | SAM을 검증된 bbox의 후처리로 연결 | 영역 경계를 정밀화. 잘못된 단서 판단 자체를 해결하지는 않음 |

프롬프트 이식 효과와 구조 변경 효과를 분리하려면 같은 모델·사진·전처리·출력 예산으로 기존 발견과 새 발견을 먼저 비교해야 한다. 그다음 OCR 문맥 crop, 후보별 탐지, 관련성 정책을 각각 바꾸어 결과를 비교한다. 사람 정답에는 단서 유형, 정확한 문자, 표면 종류, 관련성 근거, 영역을 포함하고 모델 결과를 보기 전에 작성한다.

평가 지표는 문자·비문자별 precision/recall, 문자 판독 오류, 단서와 bbox 대응 및 적합한 대상의 IoU, 중복률, 잘못 확정한 비율, 처리시간·호출량이다. 관계·반사 단서에는 일률적인 단일 bbox IoU만 적용하지 않는다. 기존 버전에서의 결과가 없는 항목은 비교표에 미측정으로 남긴다.

## 9. 적용 상태 판정

| 사용자 요구 | 신규 상태 |
|---|---|
| 문자·비문자 추출 실행 | 구현·실제 사진 실행 완료 |
| DB 저장 가능한 JSON | 구현·SQLite 저장 및 다운로드 확인 |
| bbox 또는 SAM으로 영역 연결 | bbox·OCR polygon 구현, SAM 미구현 |
| 기존보다 요구사항에 맞는 추출 품질 | 구조적 변경 완료, 정확도 우위는 미검증 |
| 기존 서비스 전체 대체 | 미완료: 정책·계약·연동 기능 차이 존재 |

새 PoC는 요구한 추출 흐름을 실행하고 오판을 추적할 수 있는 별도 실험 기반이다. 기존의 강점을 보존하면서 이식하려면 개방형 발견을 채택하되, 서버의 의미 판정 규칙과 계약 검증은 복원·연결하는 것이 다음 작업이다.

## 10. 확인한 코드와 결과 자료

다음 링크는 현재 로컬 파일을 가리킨다. 커밋을 고정한 불변 링크가 아니므로 코드가 변경되면 내용도 달라질 수 있다. 이번 작성에서는 모델 API를 호출하거나 두 앱의 코드를 수정하지 않았다.

| 근거 | 파일 |
|---|---|
| 기존 관찰 계약·12개 제한 | [structured-observation.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/structured-observation.ts:27) |
| 기존 발견 호출 | [analyze.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/analyze.ts:8) |
| 기존 병렬 처리·복구 | [parallel-pipeline.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/parallel-pipeline.ts) |
| 기존 OCR 정책 | [ocr-cue-policy.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/ocr-cue-policy.ts:28) |
| 기존 OCR 모델 입력 | [fusion-analyze.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/fusion-analyze.ts) |
| 기존 기본 질의·보충 탐지 | [grounding.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/grounding.ts:5), [supplemental-grounding.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/supplemental-grounding.ts) |
| 기존 crop 검토·체크포인트 | [object-fusion-analyze.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/object-fusion-analyze.ts) |
| 기존 규칙 등급 | [single-cue-policy.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/single-cue-policy.ts:4) |
| 기존 기록 계약·저장·연동 | [discovery.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/discovery.ts), [records.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/records.ts), [inspections.ts](C:/KKokKKok/KkokKkok-PoC/src/lib/server/inspections.ts) |
| 새 프롬프트 | [prompts.mjs](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/location-cue-lab/lib/prompts.mjs) |
| 새 계약·파이프라인 | [contracts.mjs](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/location-cue-lab/lib/contracts.mjs), [pipeline.mjs](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/location-cue-lab/lib/pipeline.mjs) |
| 새 저장·실행 설명 | [store.mjs](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/location-cue-lab/lib/store.mjs), [README.md](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/location-cue-lab/README.md) |
| 앞선 논문·공개 코드 분석 | [kkokkkok-application-analysis.md](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/kkokkkok-application-analysis.md) |
| 실제 사진 결과·오판 사례 | [photo-test-report.md](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/photo-test-report.md), [photo-test-summary.json](C:/Users/ws637/Documents/Codex/2026-11-09/https-github-com-safo-lab-doxbench/outputs/photo-test-summary.json) |

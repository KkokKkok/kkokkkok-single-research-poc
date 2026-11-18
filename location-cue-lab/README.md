**꼭꼭 Research Cue Lab**

사진 한 장에서 위치 관련 문자·비문자 후보를 개방형으로 발견하고, SQLite JSON과 이미지 영역을 연결하는 별도 로컬 PoC입니다. 기존 KkokKkok-PoC의 DB·소스·기록은 수정하지 않습니다.

**실행**

이 PC에서는 PowerShell에서 다음을 실행합니다. 기존 PoC의 설치된 Node 패키지, Python 환경, 모델 캐시 및 서버 환경설정을 읽어서 사용합니다. API 키를 브라우저로 반환하지 않습니다. 2026-11-11부터 이 폴더의 `.env`에 기존 PoC `.env.local`의 사본이 있으며, 이 `.env`가 기존 파일보다 우선합니다.

```powershell
cd "C:\KKokKKok\KkokKkok-Research-PoC\location-cue-lab"
.\start.ps1
```

브라우저에서 <http://127.0.0.1:3210>을 엽니다. 포트 변경은 `./start.ps1 -Port 3211`입니다. 화면의 사진 선택 → 단서 추출 시작으로 실행합니다. 업로드 시 설정된 OpenAI API를 사용하므로 비용이 발생합니다. 모델명은 `OPENAI_MODEL` 값이며 코드에 기본 모델을 고정하지 않았습니다.

새 PC에서는 Node 22.13 이상을 설치하고 `npm install`, `.env.example`을 `.env`로 복사한 뒤 키·모델·Python 환경을 설정합니다. `scripts/ocr-requirements.txt`와 `scripts/grounding-requirements.txt`는 각각 별도 Python 가상환경에 설치합니다. PaddleOCR 한국어 PP-OCRv5와 Grounding DINO Tiny가 최초 실행 시 가중치를 다운로드할 수 있습니다. 기존 설치를 재사용하려면 `KKOK_LEGACY_ROOT`에 기존 PoC 경로를 명시합니다. 설정 우선순위는 이미 설정된 프로세스 환경변수, 새 `.env`, 기존 `.env.local` 순서입니다.

**백엔드·안드로이드와 연결 (분석 서버)**

`analysis-server.mjs`는 Spring 백엔드가 호출하는 분석 서버입니다. 예전 런타임(`KkokKkok-PoC`의 Next.js 분석 서버와 OCR 사이드카)과 같은 경로·헤더를 받으므로, 백엔드와 안드로이드는 **코드를 바꾸지 않고 설정만** 맞추면 됩니다. 아래는 두 저장소를 새로 받은 상태에서 로컬로 연결하는 절차입니다. 배포 구성은 아직 없습니다.

흐름: 안드로이드 앱 → 백엔드(8080) → 분석 서버(3001) → Claude API·PaddleOCR·Grounding DINO·Segment Anything

1. 분석 서버 (이 폴더)

   - `npm install` (Node 22.13 이상. `@anthropic-ai/sdk`가 추가되었습니다.)
   - Python 환경은 위 **실행**의 설명대로 준비합니다(OCR, Grounding DINO. 마스크는 Grounding 환경을 같이 씁니다).
   - `.env`에 다음 두 줄을 추가합니다. 값은 Git에 올리지 않습니다.

     ```dotenv
     ANTHROPIC_API_KEY=발급받은_키
     ANALYSIS_API_KEY=백엔드와_맞출_임의의_긴_문자열
     ```

   - 실행:

     ```powershell
     cd "C:\KKokKKok\KkokKkok-Research-PoC\location-cue-lab"
     .\start-analysis.ps1          # 포트 3001. 변경: -Port 3011
     ```

   - 확인: `http://127.0.0.1:3001/api/health`가 `{"status":"ok"}`를 돌려주면 떠 있는 것입니다. 모델·키 검증은 아닙니다.

   | 환경 변수 | 기본값 | 뜻 |
   |---|---|---|
   | `ANALYSIS_API_KEY` | 없음 (필수) | 백엔드의 `NODE_ANALYSIS_API_KEY`와 같은 값 |
   | `ANTHROPIC_API_KEY` | 없음 (필수) | Claude API 키 |
   | `ANALYSIS_MODEL` | `claude-fable-5-2` | 모든 모델 단계에 쓰는 Claude 모델 |
   | `ANALYSIS_EFFORT` | `medium` | `low`~`max` |
   | `ANALYSIS_PORT` | `3001` | |
   | `ANALYSIS_INCLUDE_MASKS` | `true` | `false`면 마스크 단계와 응답의 마스크를 뺍니다 |
   | `ANALYSIS_LLM` | `claude` | `openai`면 연구용 CLI의 OpenAI 경로를 씁니다 |
   | `ANALYSIS_BIND_HOST`, `ANALYSIS_API_HOSTS` | `127.0.0.1`, 없음 | 다른 컴퓨터·컨테이너에서 호출받을 때만 설정합니다. `ANALYSIS_API_HOSTS`에 없는 Host 헤더는 403입니다 |

2. 백엔드 (`kkokkkok-backend`, 코드 변경 없음)

   JDK 17이 필요합니다. 실행할 때 환경 변수만 다음처럼 줍니다. 기본값인 `stub`에서 달라지는 것은 `ANALYSIS_PROVIDER`와 `NODE_ANALYSIS_*` 네 줄입니다.

   ```powershell
   $env:SPRING_PROFILES_ACTIVE = 'local'          # 로컬 전용: 앱 API 키 검사를 끕니다
   $env:SERVER_ADDRESS = '127.0.0.1'
   $env:ANALYSIS_PROVIDER = 'node'
   $env:NODE_ANALYSIS_BASE_URL = 'http://127.0.0.1:3001'
   $env:NODE_ANALYSIS_API_KEY = '분석 서버 .env의 ANALYSIS_API_KEY와 같은 값'
   $env:NODE_ANALYSIS_EXTERNAL_IMAGE_CONSENT = 'true'   # 사진이 Claude API로 전송됩니다
   $env:NODE_ANALYSIS_TIMEOUT_SECONDS = '120'
   .\gradlew.bat bootRun
   ```

   - `NODE_ANALYSIS_EXTERNAL_IMAGE_CONSENT`가 `true`가 아니면 백엔드가 분석 요청을 503으로 거절합니다.
   - 보호 편집은 기본값 `EDITING_PROVIDER=stub`(모의 편집)으로 두면 됩니다. 실제 편집은 백엔드의 OpenAI 키가 따로 필요하고 이 서버와 무관합니다.
   - 확인: `http://127.0.0.1:8080/actuator/health`

3. 안드로이드 (`kkokkkok-android`, 코드 변경 없음)

   앱은 백엔드 주소만 압니다. 분석 서버의 주소나 키는 앱에 넣지 않습니다.

   - 에뮬레이터: 설정을 바꿀 것이 없습니다. 기본 주소가 `http://10.0.2.2:8080`입니다.
   - USB로 연결한 실제 기기: `local.properties`에 `kkokkkok.backend.baseUrl=http://127.0.0.1:8080`을 추가해 빌드하고, `adb reverse tcp:8080 tcp:8080`을 실행합니다(USB를 다시 꽂으면 다시 실행).
   - 로그인은 기본으로 꺼져 있습니다. 켜려면 앱의 `kkokkkok.login.required=true`와 백엔드의 `AUTH_ENABLED=true` 및 카카오·네이버 값이 함께 필요합니다(각 저장소 README 참고).

4. 이 PC의 `C:\KKokKKok\kkokkkok-local\start.ps1`을 쓸 때 (2026-11-17부터 이 분석 서버가 기본)

   그 스크립트는 분석 서버(3001)와 백엔드(8098, 로그인 켜짐)를 한꺼번에 띄웁니다. 백엔드가 받는 값(`NODE_ANALYSIS_BASE_URL=http://127.0.0.1:3001` 등)은 예전 그대로이고, 3001 포트에 띄우는 프로그램만 예전 런타임에서 이 폴더의 `analysis-server.mjs`로 바꿨습니다. 사이드카(8091)는 띄우지 않습니다.

   ```powershell
   & "C:\KKokKKok\kkokkkok-local\stop.ps1"
   & "C:\KKokKKok\kkokkkok-local\start.ps1"            # 이 분석 서버 + 백엔드
   & "C:\KKokKKok\kkokkkok-local\start.ps1" -Legacy    # 예전 구성: 사이드카 + KkokKkok-PoC 분석 서버 + 백엔드
   ```

   - 서버 간 키는 `C:\KKokKKok\local-test\KkokKkok-PoC\.env.local`의 `ANALYSIS_API_KEY`를 두 서버에 같이 넘깁니다. Claude 키는 이 폴더의 `.env`에서 읽습니다.
   - 사진과 분석 기록은 `C:\KKokKKok\kkokkkok-local\analysis-research`에, 로그는 `logs\analysis.out.log`에 쌓입니다. 로그 한 줄이 한 단계이고 소요 시간(초)과 오류 코드만 남습니다.
   - 예전 구성에서 분석한 사진의 결과는 예전 분석 서버에 있으므로, 앱에서 그 이력을 열면 오류가 납니다. `-Legacy`로 띄우면 다시 보입니다.
   - 그 스크립트는 저장소 밖에 있고 이 PC의 경로가 들어 있습니다. 참고용 사본을 `local-stack/`에 두었습니다. 다른 PC에서는 맨 위의 경로 변수(`$Research`, `$ResearchDeps`, `$Poc`, `$Backend`, `$Jdk17`)를 고쳐 쓰거나 위 1~3의 수동 절차를 따릅니다. 비밀값은 스크립트에 없고 `secrets.json`과 `.env.local`에서 읽습니다.
   - 휴대폰 연결: `& "<SDK>\platform-tools\adb.exe" reverse tcp:8098 tcp:8098` (USB를 다시 꽂으면 다시 실행).

앱에서 달라지는 점 (예전 런타임 대비):

- 단서 목록에 규칙으로 판정한 단서만 나옵니다. 위험도 없이 따로 나오던 OCR 줄·탐지 객체 항목은 없습니다(`visualObservations`가 빈 배열).
- 단서 제목은 규칙의 세부 상황, 설명은 모델이 쓴 한국어 문장, 판단 근거는 규칙 판정의 근거입니다. 위험 점수는 없습니다(`riskSummary.score`가 `null`).
- 영역이 없는 단서(`bbox: null`)는 앱에 보이지만 보호 편집 대상으로 고르면 백엔드가 409를 돌려줍니다.
- 응답에 새 필드가 있습니다: 단서별 `unit`·`unitLabel`·`ruleClass`·`regions`(폴리곤·마스크), 그리고 `combinations`(단서 조합 판정). 백엔드는 그대로 통과시키고, 앱은 아직 읽지 않습니다.
- 사진 한 장에 3~5분이 걸립니다(2026-11-17, 이 PC: 189초와 268초). 앱은 5분까지 기다리고 서버는 한 장씩 처리하므로, 여러 장을 한꺼번에 분석하면 시간 초과가 납니다.

2026-11-17에 확인한 범위: 백엔드를 거쳐 사진 업로드 → 분석 요청 → 결과 조회 → 모의 보호 편집까지. 같은 날 USB로 연결한 휴대폰의 앱에서 사진 두 장을 분석해 이 서버가 처리한 것을 로그로 확인했습니다(114초, 175초). 앱 결과 화면은 위험도가 주의·높음인 단서만 세므로, 단서가 전부 낮음이면 "발견한 단서 0개"로 보입니다.

**논문에서 가져온 것과 추가한 것**

| 출처 | 적용 | 변경 이유 |
|---|---|---|
| [DoxBench GeoMiner Detector](https://github.com/SaFo-Lab/DoxBench/blob/main/code/experiment/experiment.py#L215-L247) | 이미지 세부 관찰 → 자유로운 범주 → 구체적 단서 | 범주→문자열 사전 대신 개별 단서 배열과 타입·근거·한계 추가 |
| [ClueMiner](https://github.com/SaFo-Lab/DoxBench/blob/main/code/experiment/clueminer.py#L631-L676) | 일반화된 범주명, 브랜드·장소명과 분류명 구분 | 실행 중 전역 taxonomy를 변경하지 않음 |
| Beyond the Geotag 첨부 `picture_vlm_analyze.py` | 일반 글자, 체인, 연락·지역 식별자, 구체적 장소 문자열의 차이 | 불명확한 0–10/State0–9 숫자 매핑과 전체 사진 위험도는 사용하지 않음 |
| 새 구현 | JSON 계약, OCR, DINO 질의별 영역 연결, crop 검증, SQLite, 재시도, 사람 검토 | 원 논문 프롬프트만으로 충족되지 않는 요구사항 |

프롬프트는 `lib/prompts.mjs`에서 수정합니다. 원문 그대로 재현한 실험이 아니라 논문의 추출 방식을 제품 요구사항에 맞게 이식한 버전입니다. 범주와 객체 이름은 자유 문자열이며 기존 고정 ontology·12개 제한·단독 위험도 등급은 사용하지 않습니다. 기술적 상한은 80개이며 모델이 누락 가능성을 `coverageLimited`에 보고합니다. 이 상한과 출력 토큰 한도는 완전한 재현율을 보장하지 않습니다.

**실행 단계**

1. JPEG/PNG/WebP의 방향·최대 변 3072px·색상·메타데이터를 정규화합니다. 정규화 JPEG만 저장·전송합니다. 원본 파일명, EXIF GPS와 원본 파일 자체는 이 새 앱에 저장하지 않습니다.
2. VLM이 OCR 결과를 보지 않은 상태에서 문자·비문자 단서를 발견합니다.
3. PaddleOCR이 전체 이미지와 타일에서 원문·polygon을 추출합니다.
4. VLM이 ID가 표시된 crop 묶음을 보고 OCR 영역을 하나씩 후보·보류·무관으로 분류합니다. 한 번에 8개 영역을 검토하고 서버가 모든 ID를 취합합니다. 누락·중복 참조는 해당 영역을 보류로 남깁니다. 같은 물리적 글자인 기존 문자 관찰에는 연결을 제안하지만, 별도 검증 전에는 확정하지 않습니다. 무관한 OCR도 원본에서 삭제하지 않습니다.
5. 각 localizable 관찰의 영어 질의로 Grounding DINO를 실행합니다. 모델은 한 번 로드하고 질의별 결과를 별도로 저장하므로 단순 문자열 유사도로 단서와 박스를 연결하지 않습니다.
6. 전체 문맥과 각각의 crop을 검토해 영역을 `supported`, `partial`, `rejected`로 판정합니다. 검토 전은 `pending`입니다. OCR 자체 영역은 앞 단계 crop 판정의 candidate+clear를 supported로 연결하고, 불명확한 판독은 partial로 남깁니다. 지리적 관련성이 없다고 분류한 OCR은 영역 검증을 거치지 않았으므로 `not_assessed`로 남깁니다. 관련성 없음과 영역 불일치는 다른 판단입니다. OCR과 독립 VLM 후보 사이의 연결 및 DINO 결과는 별도 crop 검증을 거칩니다. 검출 점수는 지리적 위험도나 확률이 아닙니다.
7. 사진·단서·원문 응답·모델·프롬프트 버전·사용량·단계 상태를 저장합니다. 브라우저를 닫아도 서버가 켜져 있으면 계속 진행합니다.

장면·관계 단서처럼 한 박스로 표현하기 어려운 단서는 `unlocalized`로 보존합니다. 좌표를 VLM이 만들어 내지 않습니다. 문자 VLM 관찰과 OCR 관찰은 독립 출처를 보존하고 `evidenceGroupIds`로 연결 후보를 표시합니다. 카드 수를 독립 단서 수로 해석하면 안 됩니다.

**JSON과 DB**

SQLite는 `private-data/cues.sqlite`, 분석 이미지는 `private-data/images/<UUID>.jpg`입니다. DB 테이블 `analyses`에 `id`, `created_at`, `updated_at`, `status`, `record_json`이 있으며 전체 문서는 `record_json`에 저장됩니다. `CUE_DATA_DIR`로 저장 위치를 변경할 수 있습니다.

```json
{
  "schemaVersion": "location-cues-v1",
  "id": "server-generated-uuid",
  "image": {
    "width": 1125,
    "height": 2000,
    "coordinateSpace": "analysis-normalized",
    "bboxFormat": "xyxy"
  },
  "cues": [{
    "id": "cue-0",
    "kind": "non_text",
    "category": "Architectural Details",
    "nameKo": "창문 배열",
    "observationKo": "보이는 형태와 배열",
    "geographicRelevanceKo": "장면 비교에 활용할 가능성",
    "geoSpecificityVerified": false,
    "localization": {
      "status": "supported",
      "proposals": [{
        "id": "dino-0-0",
        "source": "grounding_dino",
        "bbox": [0.1, 0.2, 0.4, 0.6],
        "score": 0.6,
        "verdict": "supported",
        "evidenceKo": "영역 안에서 확인한 근거"
      }],
      "mask": null
    }
  }],
  "humanReviews": {}
}
```

위 JSON은 형식 설명용 예시이며 실제 테스트 결과가 아닙니다. 실제 결과는 화면의 JSON 내려받기를 사용합니다. 추가 모델 원본과 OCR 원본은 `artifacts`, 단계별 진행은 `stages`에 있습니다. JSON Schema는 `lib/contracts.mjs`에서 생성하며 저장 이전 구조와 참조 ID를 검증합니다.

좌표는 EXIF 방향을 반영한 **분석 이미지**에 대한 0–1 정규화 xyxy입니다. 픽셀 좌표는 `[x1*width, y1*height, x2*width, y2*height]`입니다. OCR 다각형도 보존합니다. 여러 떨어진 조각의 union bbox는 사이 빈 영역을 포함할 수 있으므로 정밀 선택에는 polygons를 사용하세요. 원본 방향의 픽셀 좌표와 혼용하면 안 됩니다.

`supported`는 crop의 시각적 대응을 모델이 지지했다는 뜻입니다. 실제 지리적 고유성 검증이나 사람 정답이 아닙니다. 사람 판단과 선택적 수동 bbox는 `humanReviews`에 별도 저장되며 모델 원본을 덮어쓰지 않습니다.

**bbox와 SAM**

현재 구현은 bbox·OCR polygon까지 실행합니다. SAM/SAM2는 설치·호출하지 않으며 `mask:null`입니다. SAM은 단서를 발견하거나 지리적 의미를 판정하는 대체 모델이 아닙니다. 후속 연결 시 검증된 bbox를 SAM의 box prompt로 전달하고 mask를 같은 분석 좌표계의 RLE 또는 PNG로 저장하면 됩니다. 그룹·반사·관계 단서를 마스크 한 개로 표현할 수 있다고 가정하면 안 됩니다.

**HTTP API**

| 요청 | 동작 |
|---|---|
| `GET /api/config` | 설정 여부와 이 서버 실행의 로컬 요청 토큰 조회. 키 값은 반환하지 않음 |
| `POST /api/analyses` | 이미지 bytes를 body로 전송. 202와 id 반환 |
| `GET /api/analyses` | 기록 목록 |
| `GET /api/analyses/:id` | 진행 상태와 전체 JSON |
| `GET /api/analyses/:id/image` | 정규화 이미지 |
| `GET /api/analyses/:id/export` | JSON 다운로드 |
| `POST /api/analyses/:id/retry` | 실패·부분 완료 기록의 미완료 단계 재시도 |
| `POST /api/analyses/:id/reviews` | 원본과 분리한 사람 검토 저장 |

쓰기 요청에는 `/api/config`의 token을 `x-cue-token` 헤더로 보냅니다. 리뷰 body는 `{cueId,status,note,bbox,expectedUpdatedAt}`입니다. status는 accepted/rejected/uncertain/unreviewed, bbox는 유효한 xyxy 또는 null입니다. 웹 UI가 이 계약을 사용합니다. 서버는 127.0.0.1에만 바인딩하고 다른 Origin과 Host를 거부합니다. 공개 배포·사용자 인증을 갖춘 서버는 아닙니다.

**중단·실패**

OCR이 실패해도 비문자 발견·DINO·검증 결과는 보존하고 전체 상태를 partial로 남깁니다. 첫 발견 자체가 실패하면 failed입니다. 서버 재시작 시 진행 중 기록은 partial로 바뀌며 사용자가 재시도해야 합니다. 완료 단계는 재호출하지 않습니다. 실패한 검증 단계 내부에 여러 배치가 있었다면 해당 단계의 배치를 다시 호출할 수 있습니다. 이전 기록의 발견 결과를 새 프롬프트로 조용히 덮어쓰지 않으며 프롬프트 비교는 새 분석으로 실행합니다.

**CLI와 테스트**

별도 위치 단서 비교 실험 CLI는 `LOCATION-EXPERIMENT.md`에 설명되어 있습니다. 이 실험은 기존 추출 UI와 분리하여 원본 GPS를 평가 전용 정답으로 사용하고, 기본 질문·단서 추론·GeoMiner 방식·간판 마스크 조건의 예측 주소를 비교합니다. 기존 사진 추출 요청에 위치 추론을 자동 추가하지 않습니다.

```powershell
$env:KKOK_LEGACY_ROOT='C:\KKokKKok\KkokKkok-PoC'
node scripts/run-image.mjs 'C:\path\photo.jpg' 'C:\path\result.json'
node scripts/run-image.mjs --resume '<record-id>' 'C:\path\result.json'
node scripts/run-image.mjs --recheck-ocr '<source-record-id>' 'C:\path\new-result.json'
npm test
npm run check
```

CLI 분석과 웹 서버는 같은 DB를 동시에 처리하지 마세요. 웹 서버 자체는 하나의 큐에서 순서대로 실행합니다. 서버를 여러 개 실행하려면 별도 CUE_DATA_DIR를 사용하세요.

`--recheck-ocr`은 기존 기록을 보존한 채 새 기록을 생성합니다. 완료된 발견·OCR·DINO와 비문자 영역 검증은 재사용하고 OCR 관련성 판정과 문자 연결 검증을 다시 호출합니다. 이 명령은 API 비용이 발생하며 전체 프롬프트 비교 실험과는 다릅니다.

제공받은 실제 카페 사진의 실행 결과는 상위 폴더의 `photo-test-result.json`, 결과 해석과 오판 사례는 `photo-test-report.md`, 화면 증거는 `photo-test-screen.jpg`입니다. 최종 기록 ID는 `de0ae180-c9ed-4126-815b-fc68e0be48a9`입니다. 43개 관찰에는 중복 OCR이 포함되므로 43개의 독립적인 위치 단서로 해석하면 안 됩니다.

테스트는 실제 이미지 전처리·SQLite·HTTP와 모의 모델/OCR/DINO 응답을 조합해 참조 검증, 미연결 후보 보존, 원본 보존, 재시도, CSRF 거부를 검사합니다. 실제 첨부 사진 검증은 별도의 결과 보고서에서 구분합니다. 한 장의 성공은 추출 재현율을 입증하지 않으며, 사용자 기준 라벨과 다양한 사진으로 비교해야 합니다.

API 구현은 [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)와 [이미지 입력 문서](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses)를 확인했습니다. `store:false`, SDK 자동 재시도 0, 서버 환경변수 키를 사용합니다. 결과와 이미지에는 위치 관련 문자열이 포함될 수 있으므로 private-data 및 결과 JSON은 Git에 넣지 않습니다.

**논문 방식 그대로 실행**

위의 변형 파이프라인과 별개인 경로입니다. DoxBench 저장소의 프롬프트와 파싱·검증 로직을 그대로 옮겼고, 기존 DB(`cues.sqlite`)·프롬프트(`lib/prompts.mjs`)·웹 UI는 건드리지 않습니다. 웹 UI에는 아직 연결되어 있지 않으며 CLI로만 실행합니다.

| 단계 | 출처 | 구현 |
|---|---|---|
| 단서 추출 (사진마다 1회) | `experiment.py` `get_geominer_detector_prompt()`, 논문 Figure 10 | 프롬프트 원문 그대로. `Json:` 블록 추출 정규식 이식. `{범주: 세부}` 한 쌍이 단서 하나 |
| 체계 구축 (오프라인) | `clueminer.py` `_get_user_prompt()`·`build_categories()`, 논문 Figure 23 | 프롬프트 원문 그대로. 한 건씩 넣어 `{범주: 정의}` 메모리 갱신. 파싱 실패·형식 오류·8개 초과 삭제 응답은 버림 |
| 분류 (사진마다 1회) | 논문 부록 H.2 Figure 7 (ICLR 2026판은 CC BY 4.0) | 저장소에 없어 논문 그림의 문구를 그대로 사용. 조판 흔적 네 가지만 되돌림 |

프롬프트는 `lib/paper-prompts.mjs`에 있습니다. 세 프롬프트 모두 테스트가 sha256으로 고정하므로, 수정하면 `npm test`가 실패합니다. 논문에 맞추는 작업의 이전·이후와 이유는 상위 폴더의 `paper-alignment-changes.md`에 작업 순서대로 기록합니다.

```powershell
$env:KKOK_LEGACY_ROOT='C:\KKokKKok\KkokKkok-PoC'
node scripts/paper.mjs extract 'C:\path\photo.jpg'
node scripts/paper.mjs taxonomy figure25
node scripts/paper.mjs mine
node scripts/paper.mjs classify --all
node scripts/paper.mjs list
node scripts/paper.mjs settings
```

`extract`는 여러 경로를 받을 수 있고, 체계가 이미 있으면 가장 최근 체계로 분류까지 이어서 합니다(`--no-classify`로 생략). `mine`은 지금까지 추출에 성공한 사진의 단서를 모두 사용하며, 같은 사진을 여러 번 추출했으면 최신 것만 씁니다. 중단되면 `--resume <mining-run-name>`으로 같은 건부터 이어갑니다. `extract`, `mine`, `classify`는 API 비용이 발생합니다. `settings`는 API를 호출하지 않고 단계별 모델과 추론 강도, 논문 값과의 일치 여부만 보여 줍니다.

범주 체계를 얻는 방법은 두 가지입니다.

- `taxonomy figure25`: 논문 Figure 25의 31개 유형 표(5개 묶음)를 체계로 등록합니다. 모델을 호출하지 않고, 다시 실행해도 같은 체계 하나만 남습니다. 표는 `lib/paper-taxonomy-figure25.mjs`에 그림의 글자 그대로 있고 테스트가 해시로 고정합니다. 이 표는 저자들이 손으로 정리한 것이며 ClueMiner의 102개 범주가 아닙니다. 정의 문장이 없어 분류기의 정의 자리에는 `Category: <묶음>. Example: <예시>`가 들어갑니다. 미국의 주택과 거리 사진을 놓고 만든 표라 실내, 음식, 자막, 언어에 해당하는 유형이 없습니다.
- `mine`: ClueMiner로 체계를 만듭니다. `--from <체계 id>`를 주면 빈 목록 대신 그 체계의 범주에서 출발해 더하고, 합치고, 고칩니다(논문에 없는 옵션). 결과는 새 체계로 저장되고 번호가 이름순으로 다시 매겨지므로, 이어서 `classify --all`로 다시 분류합니다. 이름이 그대로 남은 범주는 묶음을 유지합니다.

`preview`는 분류된 기록이 있으면 맨 위에 범주별 집계 표를 넣습니다. `private-data/paper/preview/ko.json`의 사진별 `poorFit` 목록에 단서 ID를 적으면 "맞는 범주 없음"으로 표시하고 따로 셉니다. 분류기는 단서마다 반드시 하나를 고르게 돼 있어, 이 표시는 사람이 검토해 붙입니다.

논문·저장소와 다른 점은 다음뿐입니다.

- 이미지: 저장소는 원본 파일을 그대로 보냅니다. 여기서는 기존 `prepareImage`가 방향 보정, 메타데이터 제거, 최대 변 3072px로 정규화한 JPEG을 보냅니다.
- 호출: Chat Completions 대신 Responses API를 씁니다. 사용자 메시지 하나(프롬프트 다음에 이미지), 출력 한도 16384 토큰, temperature·시스템 프롬프트·응답 스키마 없음은 같습니다.
- 체계 구축 입력: 논문은 대도시권을 맞힌 주소 추정 응답의 `clue_list` 596건을 썼습니다. 여기서는 Detector 출력을 `범주: 세부` 문자열로 넣습니다. 주소 추정과 정답 좌표가 필요 없지만, "실제로 위치를 맞히는 데 쓰인 단서"라는 필터는 없습니다.
- 종료: 저장소는 라운드마다 사람이 계속 여부를 정합니다. 여기서는 한 라운드 동안 메모리가 바뀌지 않으면 끝내고, `--max-rounds`(기본 5)에 닿으면 수렴하지 않은 채로 저장합니다.
- 재시도: Detector나 분류기 응답이 파싱되지 않으면 한 번 더 호출합니다.
- 범주 목록: 논문의 102개 범주는 전체가 공개되어 있지 않습니다. 사진이 적은 동안은 논문 Figure 25의 31개 유형 표를 쓰고, 사진이 모이면 `mine`으로 직접 만듭니다. 사진 수가 적으면 만든 범주가 적고 불안정합니다.

단서에는 이미지 좌표가 없습니다. 논문 방식의 출력은 텍스트뿐입니다.

결과는 `private-data/paper` 아래에 저장됩니다. `runs/<id>.json`이 사진별 기록(`schemaVersion: paper-clues-v2`, 단계별 모델 설정과 모델 원응답 포함), `images/<id>.jpg`가 정규화 이미지, `taxonomy/<id>.json`이 번호가 붙은 범주 체계, `clueminer/<run>/`이 건별 입력·응답 로그와 `final_categories.json`입니다. 

**2026-11-18부터 연구용 CLI(`scripts/paper.mjs`와 실험 스크립트)의 기본 모델은 Claude API입니다.** 분석 서버와 같은 설정(`ANTHROPIC_API_KEY`, `ANALYSIS_MODEL` 기본 `claude-fable-5-2`, `ANALYSIS_EFFORT` 기본 `medium`)을 씁니다. 예전 OpenAI 경로는 `PAPER_LLM=openai`일 때만 쓰이며, 아래의 `OPENAI_MODEL`·`PAPER_*_MODEL` 설명은 그 경우에 해당합니다. Claude에서는 Detector 프롬프트에서 "Think" 한 줄만 뺀 변형(`paper-detector-no-think-v1`)을 씁니다.

모델은 현재 설정된 모델(`OPENAI_MODEL`)을 씁니다. 코드에 모델 이름을 기본값으로 고정하지 않으므로, 최신 모델을 쓰려면 `OPENAI_MODEL`만 바꾸면 됩니다. 단계별로 다르게 쓰려면 `PAPER_DETECTOR_MODEL`, `PAPER_CLUEMINER_MODEL`, `PAPER_CLASSIFIER_MODEL`을, 추론 강도를 명시하려면 `PAPER_<단계>_REASONING_EFFORT`를 지정합니다(기본은 저장소처럼 보내지 않음). 논문이 쓴 모델은 참고값으로만 남아 있습니다. Detector는 `gpt-4o-2024-11-20`, 분석기와 분류기는 `o4-mini-2025-04-16`입니다. 기록의 `stages.<단계>`에 실제로 쓴 모델과 논문 값, 일치 여부(`matchesPaper`)가 함께 남으므로, 최신 모델로 돌린 결과는 `matchesPaper: false`로 표시됩니다.

**API 키 없이 실행 (파일 전달 방식)**

`extract`, `mine`, `classify`에 `--handoff <대역 이름>`을 붙이면 OpenAI API를 호출하지 않습니다. 모델에 보낼 요청을 `private-data/paper/handoff/<id>/`에 파일로 쓰고 멈춥니다. 대역(Claude 세션, 사람, 다른 도구)이 그 폴더의 `prompt.txt`와 `image.jpg`를 보고 답을 `response.txt`에 쓰면, 같은 명령을 다시 실행했을 때 이어서 진행합니다. 프롬프트·파서·검증 로직은 API 경로와 같은 코드입니다.

```powershell
node scripts/paper.mjs extract 'C:\path\photo.jpg' --handoff claude-fable-5-2
node scripts/paper.mjs pending
node scripts/paper.mjs extract 'C:\path\photo.jpg' --handoff claude-fable-5-2
```

- 답을 기다리는 동안 기록은 `pending` 상태이고 오류로 세지 않습니다. 종료 코드는 3입니다.
- 같은 요청(대역 이름, 프롬프트, 이미지, 시도 횟수)은 같은 폴더를 쓰므로 다시 실행해도 요청이 중복되지 않습니다.
- `mine`은 단계마다 멈춥니다. 답을 쓴 뒤 `mine --handoff <대역 이름>`을 다시 실행하면 끝나지 않은 실행을 자동으로 이어갑니다.
- `pending`은 답을 기다리는 요청과 대역에게 줄 지시문을 보여 줍니다.

이 방식의 결과는 API 호출 결과와 조건이 다릅니다. 대역에게는 "한 번의 모델 호출을 대신한다"는 지시문이 따로 주어지고, 출력 토큰 한도나 추론 강도 같은 API 파라미터가 없으며, 대역 자체의 시스템 프롬프트가 있을 수 있습니다. 기록에는 `transport: handoff`와 대역 이름이 남고 `matchesPaper`는 항상 `false`입니다.

**단서의 이미지 영역과 미리보기 (논문에 없는 추가 단계)**

논문 방식의 단서는 글뿐이라 사진의 어디인지 알 수 없습니다. `regions`는 추출된 단서에 영역을 붙이고, `preview`는 상자를 그린 사진과 단서 목록을 한 페이지로 만듭니다.

```powershell
node scripts/paper.mjs regions --all
node scripts/paper.mjs preview
```

- 글자: 단서가 따옴표로 적은 문자열을 PaddleOCR이 읽은 줄과 대조합니다. 모델을 쓰지 않습니다. OCR이 한 글자쯤 틀리게 읽은 줄, 문구의 일부만 읽은 줄도 연결합니다.
- 물체: 모델이 단서의 글만 보고(사진은 보지 않음) 검출용 영어 문구를 단서당 최대 4개 만들고, Grounding DINO가 그 문구로 상자를 찾습니다. 이 프롬프트는 `lib/paper-regions.mjs`에 있으며 논문의 것이 아닙니다.
- 좌표는 OCR과 DINO에서만 나옵니다. 모델에게 좌표를 묻지 않습니다.
- 영역은 검증하지 않은 제안입니다. 기존 경로의 crop 검증 단계는 붙이지 않았으므로, 상자가 단서와 다른 대상을 가리킬 수 있습니다.
- 계절, 문화, 화면 구성처럼 한 영역으로 가리킬 수 없는 단서는 영역 없이 남습니다.
- 사진 한 장에 CPU로 수 분이 걸립니다. `--force`는 이미 영역이 있는 기록도 다시 계산합니다.
- `preview`는 `private-data/paper/preview/index.html`을 만듭니다. 사진이 파일 안에 들어 있으므로 외부에 올리지 마세요. 같은 폴더의 `ko.json`(`{기록ID: {단서ID: 한글 설명}}`)이 있으면 한글 설명을 함께 보여 줍니다. 한글 설명은 파이프라인의 출력이 아니라 따로 써 넣는 것입니다.
- 미리보기는 같은 자리의 상자를 하나로 합치고, 물체 상자는 문구마다 점수가 가장 높은 것 하나만(0.35 이상) 그립니다. 기록에는 모든 후보가 남습니다.

**주소 추정 실험 (평가 전용)**

`locate`는 논문의 본 실험을 그대로 실행합니다. 사진과 함께 "where is it?"을 묻고, 모델이 쓴 단서 목록(`clue_list`)과 주소 후보(`address_list`)를 받습니다. 프롬프트는 `experiment.py`의 `get_standard_prompt()`(CoT 방식) 원문이고 테스트가 해시로 고정합니다.

```powershell
node scripts/paper.mjs locate --all
node scripts/paper.mjs locate <기록ID> --top3
```

- **평가 전용입니다.** 꼭꼭의 제품 경로는 촬영 위치를 추론하지 않습니다. 이 명령은 "가상의 공격자가 이 사진에서 어디까지 알아내는가"를 재는 실험이며, 사진의 주인이 동의한 사진에만 씁니다.
- 모델에는 메타데이터가 없는 분석 이미지만 갑니다. 정답 좌표는 이 명령이 알지 못하고, 채점은 별도 단계입니다.
- 결과는 기록의 `predictions`에 모델별로 하나씩 저장됩니다. 주소 후보를 내지 않은 응답은 오류가 아니라 `no_address`로 남습니다(논문의 유효 응답률에 해당).
- 저장소처럼 한 번만 묻고 재시도하지 않습니다.
- 주소 형식은 원문 그대로 미국식(`[Street Number] [Street Name] ..., [State Abbreviation] [ZIP Code]`)을 요구합니다. 한국 주소에는 맞지 않는 형식입니다.
- 모델은 `PAPER_LOCATOR_MODEL`, 추론 강도는 `PAPER_LOCATOR_REASONING_EFFORT`로 지정하며 기본은 `OPENAI_MODEL`입니다. 논문은 o3(추론 강도 medium), GPT-4.1, Gemini 2.5 Pro의 응답을 썼습니다.

**주소 추정 채점 (평가 전용)**

`score`는 `locate`가 저장한 주소 후보를 좌표로 바꾸고, 원본 사진의 EXIF 좌표와의 거리를 잽니다. 거리가 반경(기본 500m) 안이면 맞힌 것으로 기록합니다.

```powershell
node scripts/paper.mjs score <원본 사진> [<원본 사진> ...]
node scripts/paper.mjs score <원본 사진> --radius 1000 --force
node scripts/paper.mjs score --pilot ..\location-experiment-pilot
```

- `--pilot <폴더>`는 원본 사진 대신 기존 위치 실험이 이미 읽어 둔 EXIF 좌표를 씁니다. 그 실험의 `manifest.json`이 가리키는 분석 이미지의 해시로 기록을 찾습니다. 원본 파일이 손에 없을 때 씁니다.
- 네이버는 서양식 순서의 영어 주소(`84 Heukseok-ro, Dongjak-gu, Seoul`)를 찾지 못합니다. 그래서 주소를 그대로 → 응답 언어만 영어로 → 한국식 순서(`Seoul Dongjak-gu Heukseok-ro 84`)로 바꿔 영어로, 이 순서로 시도합니다. 어느 형식으로 찾았는지는 `score.candidates[].queryForm`에 남습니다. 재배열은 저장소에 없는 처리입니다.
- 모델이 주소 뒤에 괄호로 설명을 붙이면(`..., South Korea (○○마트 ○○점)`) 네이버는 결과를 찾지 못하고, 검색어가 100~120자를 넘으면 HTTP 400을 돌려줍니다. 그래서 위 세 형식이 모두 실패하면 괄호 설명을 뺀 주소로 같은 세 형식을 한 번 더 시도하고(`without_remarks…`), HTTP 400은 다음 형식으로 넘어갑니다. 이것도 저장소에 없는 처리입니다.
- 반경 안에 든 추정의 단서 목록은 위험 근거(추정)로 봅니다. `preview`가 사진마다 맞힘 여부, 거리, 그 단서 목록을 보여 줍니다.
- 네이버 키는 지도 Application의 **Client ID(영숫자 10자)와 Client Secret(영숫자 40자)**입니다.

**사진 속 글자를 장소 검색에 넣어 보기 (평가 전용, 논문에 없는 추가)**

`score`는 모델이 혼자 알아낸 주소를 채점합니다. 모델은 검색을 못 하므로, 간판에 상호가 또렷이 보여도 그 가게가 어디인지 모르면 틀립니다. `places`는 다른 질문에 답합니다. 사진에서 읽은 글자를 지도 검색에 그대로 넣으면 그 장소가 나오는가입니다.

```powershell
node scripts/paper.mjs places --pilot ..\location-experiment-pilot
node scripts/paper.mjs preview
```

- 검색어는 Detector가 단서에 따옴표로 적은 글자 전부입니다(사진당 최대 20개). 상호만 고르지 않습니다. 메뉴 문구나 사진에 얹은 자막도 검색됩니다.
- 검색은 NAVER API HUB의 지역 검색 API입니다(`GET https://naverapihub.apigw.ntruss.com/search/v1/local`). 글자와 결과 개수(5)만 보냅니다. 정답 좌표는 보내지 않습니다.
- 글자마다 검색된 곳의 수(`total`), 첫 결과까지의 거리, 첫 결과가 반경 안인지(`topWithinRadius`), 보여 준 결과 중 하나라도 반경 안인지(`anyWithinRadius`)를 기록의 `placeSearches`에 남깁니다. 좌표와 주소는 저장하지 않고 업체 이름과 거리만 남깁니다.
- 키는 지도 키와 다릅니다. 콘솔의 `Application Services > NAVER API HUB`에서 이용 신청을 하고, 지역 검색을 선택해 Application을 등록한 뒤 `[인증 정보]`의 값을 `.env`의 `NAVER_APIHUB_CLIENT_ID`, `NAVER_APIHUB_CLIENT_SECRET`에 넣습니다. 지도 Application의 키로 부르면 401 "A subscription to the API is required"가 납니다.
- 한 번에 5곳까지만 받습니다. 같은 이름의 가게가 5곳보다 많으면 그 장소가 결과에 없을 수 있습니다.
- 정답 좌표 없이 건수만 세는 명령은 `node scripts/paper.mjs probe --all`입니다. `probe --export [--out 파일]`은 저장된 건수를 (기록, 단서, 글자)마다 한 줄씩 `private-data/paper/probe-counts.jsonl`에 씁니다. 누적 분석용이며 좌표는 들어가지 않습니다. `capped: true`인 줄은 건수가 상한(5)에 닿은 것이라 "5곳 이상"으로 읽어야 합니다.
- 응답의 `total`은 일치한 곳의 수가 아닙니다(결과가 없어도 5가 옵니다). 기록의 `total`은 실제로 돌려받은 곳의 수입니다. 좌표 `mapx`, `mapy`는 도 단위에 10^7을 곱한 정수로 옵니다. 콘솔의 `Application Services > Maps > Application`에서 Geocoding을 선택해 등록한 뒤 `[인증 정보]`에서 확인합니다. `ncp_iam_`으로 시작하는 계정 API 인증키는 지도 API에 쓸 수 없고 401이 납니다.

- 인자는 **EXIF가 남아 있는 원본 사진**입니다. 분석 이미지의 해시로 기록을 찾으므로 `extract`에 넣었던 것과 같은 파일이어야 합니다.
- 지오코딩은 네이버 클라우드 Maps Geocoding이 기본입니다. `.env`에 `NAVER_MAPS_CLIENT_ID`, `NAVER_MAPS_CLIENT_SECRET`을 넣고, 콘솔의 Application에서 Geocoding을 선택해야 합니다. 국내 주소만 찾습니다. `--geocoder google`은 논문과 같은 Google Geocoding(`GOOGLE_MAPS_API_KEY`)을 씁니다.
- 지오코더에는 주소 문자열만 보냅니다. 정답 좌표로 결과를 유도하는 옵션은 쓰지 않습니다.
- 저장소와 같게 첫 번째 지오코딩 결과를 쓰고, 거리는 `pyproj.Geod(WGS84).inv`로 계산하며, 후보가 여럿이면(`--top3`) 가장 가까운 후보로 채점합니다.
- 결과는 각 추정의 `score`에 저장됩니다(거리, 반경 안 여부, 후보별 지오코딩 상태). 정답 좌표와 지오코더가 돌려준 좌표는 저장하거나 출력하지 않습니다.
- 이미 채점된 추정은 건너뜁니다. 반경이나 지오코더를 바꿔 다시 채점하려면 `--force`를 붙입니다.
- 키가 없거나 거부되면 채점을 멈추고 `geocoder_unavailable`을 출력합니다. 기록은 바뀌지 않습니다.

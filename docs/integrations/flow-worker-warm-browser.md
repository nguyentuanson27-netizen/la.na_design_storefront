# Thiết kế: flow-worker giữ Chrome chạy sẵn (warm browser)

Trạng thái: **đã duyệt và đã triển khai sau cờ `FLOW_WARM_BROWSER` (mặc định tắt).** Vận hành: xem mục
"Warm browser" trong [`google-flow-virtual-try-on.md`](google-flow-virtual-try-on.md). Chưa đo trên
tài khoản Flow thật: giai đoạn 0 (đo) và bật thử vẫn phải làm trên VPS.

Quyết định của chủ shop: (1) runner là tiến trình con riêng; (2) trần 1,5 GB RAM, nghỉ sau 30 phút
hoặc tái chế sau 50 lượt; (3) chấp nhận giữ lease profile, kèm `POST /v1/cool` và runbook. Các mặc định
đã đặt: nghỉ 1800 s, tối đa 50 lượt, tuổi tối đa 3600 s, tái chế khi cây tiến trình Chrome đạt 1200 MB
(thấp hơn trần container 1536 MB để worker tự tái chế trước khi Docker phải khởi động lại).
Liên quan: [`google-flow-virtual-try-on.md`](google-flow-virtual-try-on.md), `services/flow-worker/`.

Căn cứ: đọc mã nguồn `gflow-cli` 0.82.1. Wheel tải về có sha256 trùng hash đã ghim trong
`services/flow-worker/Dockerfile`. Chưa chạy thử với tài khoản Flow thật, nên mọi con số thời gian và
RAM dưới đây là **ước lượng, cần đo ở giai đoạn 0**.

## 1. Hiện trạng và phát hiện chính

Mỗi request, `server._run_gflow` chạy `python -m flow_worker.gflow_launcher image i2i ...` thành một
tiến trình riêng. Mỗi tiến trình đó phải:

1. Khởi động Python và import `gflow_cli`.
2. Lấy lease profile, mở Chrome với profile đã đăng nhập (`launch_persistent_context`).
3. Điều hướng bootstrap tới `flow.google.com` để nạp cookie và JS, rồi dựng transport.
4. Mới tới phần việc thật: vào project, đính ảnh, sinh, tải kết quả.
5. Đóng Chrome, nhả lease.

Các bước 1–3 và 5 là chi phí cố định. Đây là phần mà "warm browser" cắt được.

Phát hiện từ mã `gflow-cli` (đường dẫn trong gói `gflow_cli/`):

- `FlowApiClient` (`api/client.py`) là một async context manager. `__aenter__` làm bước 2–3,
  `__aexit__` làm bước 5. **Một client đã vào `async with` dùng lại được cho nhiều lần
  `generate_image` + `download_image`.** Đây là điểm tựa của thiết kế.
- Mỗi lần sinh ảnh, transport `ui_automation` tự `goto` tới trang project và **tự đưa trang về
  `about:blank` sau khi xong** (`_park_composer_page`). Lý do được ghi trong mã: để request sau không
  thừa hưởng composer đang mở. Tức là "tab mở sẵn trong project" mà đề bài nêu thì gflow đã dọn về
  trạng thái sạch sau mỗi lượt. Giữ nguyên hành vi này, vừa an toàn cho dữ liệu khách vừa đơn giản.
- `gflow serve` (`worker/daemon.py`) là hàng đợi tác vụ dựa trên SQLite, **không** phải
  giải pháp cho yêu cầu này. Nó mở lại `FlowApiClient` cho mỗi tác vụ (dòng 183 và 327), nên vẫn
  khởi động Chrome mỗi lần.
- `get_settings()` được cache bằng `lru_cache`, nên `GFLOW_CLI_DB_PATH` đặt riêng theo request như
  hiện nay **không có tác dụng** trong một tiến trình sống lâu. Chế độ warm phải bỏ qua
  `OperationRecorder` (không ghi lịch sử vào SQLite). Việc này còn tốt hơn cho riêng tư.

Kết luận: không cần sửa `gflow-cli` hay tự viết lại phần điều khiển Flow. Chỉ cần worker tự giữ một
`FlowApiClient` sống lâu và gọi vài hàm công khai của nó.

## 2. Kiến trúc đề xuất

```text
HTTP thread (ThreadingHTTPServer)         Runner thread (một asyncio loop riêng)
  POST /v1/try-on                           WarmRunner
    kiểm tra token, ảnh, khóa BUSY   --->     state: COLD | STARTING | WARM | RECYCLING
    runner.submit(person, product)            FlowApiClient  (giữ nguyên giữa các request)
         <-- future.result(timeout) --        generate_image -> download_image
  POST /v1/warm  (mới)             --->     ensure_started() không chờ
  GET  /health   (mở rộng)                  trả state, tuổi, số lượt, RSS
```

- Một thread chạy một event loop duy nhất, giữ client. HTTP thread gửi việc qua
  `asyncio.run_coroutine_threadsafe`. Giữ nguyên `_generation_lock`: mỗi lúc chỉ một lượt sinh.
- Mỗi lượt trong runner, theo thứ tự `cli_image._run_i2i`:
  1. Ghi ảnh tạm vào tempdir của request, tên ngắn `person.jpg`/`garment.jpg` (giữ nguyên ghi chú về
     độ dài tên trong `_generate`).
  2. Dựng `GenerateImageRequest(prompt, aspect, model, ref_paths=(...))`. Không dùng `@mention`,
     nên không cần `resolve_and_apply`.
  3. `await client.generate_image(project_id=_project_id, req=req)`, rồi
     `await client.download_image(image, output_path)`.
  4. Xóa tempdir (đã có `TemporaryDirectory`).
- Giữ nguyên toàn bộ chính sách hiện có: Nano Banana Pro trước, 2.1 khi hết quota
  (`policy.should_fallback_from_pro`), ánh xạ lỗi trong `_failure_reason`, các bản vá
  `gflow_prompt_guard`/`gflow_models` (cài một lần lúc runner khởi động, vì đã chạy trong cùng
  tiến trình).
- `_ensure_project` (tạo project một lần) vẫn dùng đường subprocess cũ, vì chỉ chạy một lần và
  không nằm trên đường nóng. Chỉ cần chạy xong trước khi runner mở client.

### Đường lui (fallback)

Biến `FLOW_WARM_BROWSER=1` bật chế độ warm, mặc định **tắt**. Khi tắt, hoặc khi runner gặp lỗi khởi
động hay lỗi hạ tầng (không phải lỗi nội dung/quota), worker rơi về đường subprocess hiện tại cho
chính request đó. Như vậy bật warm không làm mất tính năng nếu có sự cố, và rollback chỉ là đổi một
biến môi trường.

## 3. Vòng đời để tiết kiệm tài nguyên máy chủ

Ba trạng thái, chuyển theo hoạt động thật:

| Trạng thái | Điều kiện | Chrome |
|---|---|---|
| COLD | chưa có hoạt động, hoặc đã nghỉ quá `FLOW_WARM_IDLE_SECONDS` (mặc định 600) | không chạy |
| STARTING | nhận `POST /v1/warm` hoặc một request khi đang COLD | đang mở, vào `async with` |
| WARM | client đã sẵn sàng | một Chrome, một trang, trang đỗ ở `about:blank` |

- **Pre-warm.** Khi khách mở hộp thoại thử đồ (hoặc chọn ảnh), storefront gọi `POST /v1/warm`
  (cùng bearer token, trả về ngay, không chờ). Lúc khách xác nhận và bấm tạo ảnh, Chrome thường đã
  sẵn sàng. Request nào đến khi đang STARTING thì chờ client xong rồi chạy tiếp, trong cùng ngân
  sách `FLOW_COMMAND_TIMEOUT_SECONDS`.
- **Chống lạm dụng warm.** Storefront chỉ gọi warm cho khách đã qua các cổng sẵn có
  (đăng nhập hoặc rate limit hiện hành). Worker bỏ qua `warm` nếu đã WARM/STARTING, và giới hạn một
  lần khởi động mỗi `FLOW_WARM_MIN_RESTART_SECONDS` (mặc định 60).
- **Nghỉ.** Bộ hẹn giờ trong runner: không có lượt nào trong `FLOW_WARM_IDLE_SECONDS` thì thoát
  `async with`, đóng Chrome, nhả lease, về COLD. Ban đêm gần như không tốn RAM.
- **Tái chế (recycle)** khi đang rảnh, nếu một trong các điều kiện sau đúng, để chống rò rỉ bộ nhớ
  của tab chạy lâu:
  - đã xử lý `FLOW_WARM_MAX_JOBS` lượt (mặc định 25), hoặc
  - client đã sống quá `FLOW_WARM_MAX_AGE_SECONDS` (mặc định 3600), hoặc
  - tổng RSS của cây tiến trình Chrome vượt `FLOW_WARM_MAX_RSS_MB` (mặc định 900; đọc từ `/proc`,
    cùng cách `_chrome_uses_profile` đang duyệt `/proc`).
- **Tự chữa.** Trước mỗi lượt, kiểm tra client còn sống (`health_check()` của client, rẻ). Lượt sinh
  gặp lỗi kiểu `TargetClosedError`/trang chết thì đánh dấu RECYCLING, dựng lại client, và thử lại
  **đúng một lần** nếu lỗi xảy ra trước khi bấm gửi (chưa tiêu quota). Sau khi đã gửi thì không tự
  thử lại, để không đốt quota hai lần.

## 4. Giới hạn Chrome và container

Chrome (qua `gflow_cli`) hiện chạy headed trên Xvfb. Giữ nguyên, vì cơ chế chống bot của Flow cần.
Chỉ giảm tải ở những chỗ không đụng vào hành vi trang:

- Đặt `GFLOW_CLI_CONCURRENCY=1` (mặc định đã là 1): một trang trong pool.
- Hạ Xvfb từ `1280x1024x24` xuống `1280x800x24` trong `entrypoint.sh`.
- Thử từng cờ Chrome ở giai đoạn 0 và chỉ giữ cờ nào không làm đổi kết quả hay điểm reCAPTCHA:
  `--disable-dev-shm-usage`, `--disable-background-networking`, `--disable-extensions`,
  `--mute-audio`, `--js-flags=--max-old-space-size=256`. **Không** dùng `--single-process` hay
  `--disable-gpu` cho đến khi có số liệu, vì dễ làm Chrome mất ổn định hoặc đổi dấu vân tay.
  Wrapper `/opt/google/chrome/chrome` trong Dockerfile là chỗ thêm cờ.
- `deploy/vps/compose.yml`, service `flow-worker`:

  ```yaml
  mem_limit: 1536m
  mem_reservation: 768m
  memswap_limit: 1536m   # không dùng swap
  cpus: "1.5"
  shm_size: "512m"       # hạ từ 1gb nếu có --disable-dev-shm-usage
  pids_limit: 512        # giữ nguyên
  ```

  Con số lấy từ ước lượng, cần xác nhận bằng đo thực tế rồi mới chốt. Khi vượt `mem_limit`, container
  bị khởi động lại mà không kéo cả VPS, và `restart: unless-stopped` dựng lại worker ở trạng thái COLD.

## 5. Riêng tư và an toàn

- Giữa hai khách không còn gì trong trang: gflow đưa trang về `about:blank` sau mỗi lượt, và
  tempdir của request bị xóa như hiện nay.
- Chế độ warm **không** dùng `OperationRecorder`, nên không có prompt, hash, đường dẫn hay media ID
  nào ghi xuống đĩa (hiện đang được bảo vệ bằng cách đặt DB trong tempdir).
- Nhật ký chỉ chứa metadata có giới hạn, theo đúng quy ước `_event` hiện có.
- `FLOW_WORKER_TOKEN` vẫn bị loại khỏi môi trường của Chrome như hiện nay (`_gflow_env`). Chrome
  khởi động trong tiến trình worker nên phải xóa biến này khỏi `os.environ` của runner thread, hoặc
  chạy runner như một tiến trình con riêng (xem câu hỏi mở số 1).
- Giữ nguyên lớp chống bot hiện có: `GFLOW_CLI_FLOW_HOST=flow.google.com` và hai bản vá chỉ cài
  khi đúng host.

## 6. Việc vận hành thay đổi

- **Lease profile bị giữ lâu.** Khi WARM, worker giữ lease của profile. `gflow auth login` hay
  `docker compose run` chạy tay sẽ nhận `ProfileLockedError`. Runbook phải ghi rõ: dừng worker
  (hoặc gọi endpoint nghỉ) trước khi đăng nhập lại. Có thể thêm `POST /v1/cool` (cùng token) để
  nhả Chrome ngay mà không cần restart.
- `_clean_stale_profile_locks` vẫn đúng: nó chỉ xóa khi lấy được lease, và lease đang bị giữ thì nó
  không làm gì.
- `/health` trả thêm `state`, `ageSeconds`, `jobs`, `rssMb`. Docker healthcheck hiện tại chỉ đọc
  mã trạng thái, vẫn dùng được.

## 7. Số liệu để chỉnh ngưỡng

Mỗi lượt ghi thêm (chỉ số, không có nội dung của khách): `warm_state_at_start`,
`startup_ms` (chỉ khi phải mở Chrome), `generate_ms`, `rss_mb_after`, `recycle_reason`. Từ đó đối chiếu
trước và sau, và chỉnh `IDLE_SECONDS`, `MAX_JOBS`, `MAX_RSS_MB`.

## 8. Các giai đoạn

0. **Đo, không đổi hành vi.** Thêm các số liệu ở mục 7 vào đường subprocess hiện tại. Đo thời gian
   từng bước và RSS của Chrome. Thử từng cờ ở mục 4 trên máy thật. Đây là điều kiện để chốt mọi con
   số.
1. **WarmRunner sau cờ `FLOW_WARM_BROWSER`, mặc định tắt.** Có đường lui sang subprocess. Test đơn
   vị bằng một `FlowApiClient` giả (repo đã có `fake_flow_composer.html` và test cho server).
2. **Pre-warm và nghỉ.** `POST /v1/warm`, bộ hẹn giờ nghỉ, tái chế. Storefront gọi warm khi mở hộp
   thoại.
3. **Giới hạn container và runbook.** Cập nhật `compose.yml`, `entrypoint.sh`, tài liệu vận hành.
4. **Bật thử** trên môi trường thật với một phần lưu lượng, so số liệu giai đoạn 0, rồi mới bật mặc
   định.

Giai đoạn tùy chọn sau cùng: giữ composer mở sẵn ở trang project thay vì `about:blank` để tiết kiệm
thêm bước `goto` (vài giây). Không làm trước, vì phải bỏ hành vi dọn trang của gflow, tức là tăng
rủi ro lẫn dữ liệu giữa các khách.

## 9. Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| Gọi `FlowApiClient` trực tiếp là API nội bộ, `gflow-cli` đã ghim 0.82.1 nhưng đổi phiên bản có thể làm vỡ | Ghim phiên bản như hiện nay; test hợp đồng với client giả; đường lui sang subprocess |
| Tab sống lâu bị đăng xuất hoặc bị Flow chặn giữa chừng | Kiểm tra sức khỏe trước mỗi lượt; lỗi AUTH vẫn ánh xạ sang `AUTH_FAILED` như cũ và kích hoạt tái chế |
| Rò rỉ bộ nhớ | Tái chế theo số lượt, tuổi và RSS; `mem_limit` làm lưới an toàn cuối |
| Một lượt treo giữ cả runner | Ngân sách `FLOW_COMMAND_TIMEOUT_SECONDS` giữ nguyên; hết hạn thì hủy tác vụ và tái chế client |
| Pre-warm bị lạm dụng để giữ máy chủ bận | Chỉ gọi sau các cổng sẵn có, giới hạn tần suất khởi động |

## 10. Câu hỏi mở: đã quyết

1. Runner chạy như **tiến trình con riêng** (`flow_worker/warm_child.py`), giao tiếp qua pipe bằng
   JSON theo dòng. Chrome không bao giờ thấy `FLOW_WORKER_TOKEN`.
2. Trần RAM 1,5 GB (`mem_limit: 1536m`), nghỉ sau 30 phút, tái chế sau 50 lượt. Các ngưỡng còn lại
   (tuổi 1 giờ, RSS 1200 MB) là mặc định để chỉnh sau khi đo ở giai đoạn 0.
3. Chấp nhận giữ lease. Có `POST /v1/cool`, và `deploy.sh` tự gọi nó trước các lệnh `gflow auth status`
   (lệnh này mở một Chrome thứ hai trên cùng profile nên sẽ lỗi nếu worker đang warm).

## 11. Những gì đã làm so với bản thiết kế

- `warm.py` (quản lý vòng đời) và `warm_child.py` (tiến trình giữ `FlowApiClient`); `server.py` nối
  vào `_run_model`, thêm `POST /v1/warm`, `POST /v1/cool`, `warm` trong `/health`, tắt sạch khi
  SIGTERM. Mọi `_run_gflow` (đường cũ, `_ensure_project`) nhả trình duyệt warm trước khi chạy.
- Storefront: `GET /api/try-on` (hộp thoại gọi khi mở) gọi `warmFlowWorker` nếu khách còn lượt và
  provider là Flow, **và chỉ khi trình duyệt tự gắn `Sec-Fetch-Site: same-origin`** (trang của site
  khác có thể khiến trình duyệt gửi GET này, ví dụ qua `<img src>`, nhưng không thể giả header đó;
  thiếu header thì không warm). Không chờ, không bao giờ làm hỏng câu trả lời.
- Ngân sách một request dùng chung cho đường warm và đường lui: nếu warm tốn thời gian rồi báo
  không dùng được, gflow theo request chỉ nhận phần còn lại của hạn chót, và không chạy nếu đã hết.
- `POST /v1/cool` là **rào chắn thật** (sửa theo review): nó huỷ lượt khởi động đã lên lịch hoặc đang
  chạy, rồi giữ trình duyệt tắt và **đóng worker với mọi try-on** trong `FLOW_WARM_COOL_PAUSE_SECONDS`
  (900 s): không gợi ý warm nào mở Chrome, và `POST /v1/try-on` trả `409 BUSY` (kiểm tra dưới
  `_generation_lock`, cùng khóa mà `/v1/cool` giữ khi đặt đợt tạm dừng, nên request nào cũng hoặc đứng
  trước cool và được chờ, hoặc đứng sau và bị từ chối). Nhờ đó không có gflow nào của khách tranh
  profile với `gflow auth status` của người vận hành. Trả `409` nếu không nhả được trong 15 s.
  `POST /v1/resume` kết thúc đợt tạm dừng sớm; đợt tạm dừng tự hết sau 900 s nếu quên. Khi
  `FLOW_WARM_BROWSER` tắt, không có gì thay đổi (khoảng trống cũ giữa deploy và lưu lượng vẫn như trước). Mọi gflow theo request cũng giữ trình duyệt warm
  tắt suốt thời gian nó chạy (`WarmRunner.exclusive`). `deploy.sh` dừng deploy nếu một worker đang chạy
  mà không cool được (404 = worker bản cũ, bỏ qua).
- Chưa làm: cờ Chrome giảm RAM, hạ Xvfb, giữ composer mở sẵn. Cả ba chờ số liệu ở giai đoạn 0.
- Sai khác nhỏ so với bản thiết kế: tái chế sau lượt lỗi (thay vì thử lại một lần trong cùng client);
  không có `ping` trước mỗi lượt, vì lượt nào gặp trình duyệt chết trước khi gửi sẽ chạy bằng đường cũ.

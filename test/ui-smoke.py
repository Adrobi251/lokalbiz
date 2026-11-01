"""Browser smoke tests. Run with webapp-testing/scripts/with_server.py and the Vite dev server on port 5173."""

import json
import os
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

BASE_URL = os.environ.get("LOKALBIZ_WEB_URL", "http://127.0.0.1:5173")
BUSINESS_ID = "11111111-1111-4111-8111-111111111111"
PRODUCT_ID = "22222222-2222-4222-8222-222222222222"
BUSINESS = {
    "data": {
        "id": BUSINESS_ID,
        "name": "Warung QA",
        "currency": "IDR",
        "timeZone": "Asia/Jakarta",
        "createdAt": "2026-01-01T00:00:00.000Z",
    }
}
EMPTY_PAGE = {
    "data": [],
    "pagination": {"page": 1, "pageSize": 20, "totalItems": 0, "totalPages": 0},
}
PRODUCT_PAGE = {
    "data": [{
        "id": PRODUCT_ID,
        "name": "Kopi",
        "sku": None,
        "sellingPrice": 2500,
        "currency": "IDR",
        "stockQuantity": 5,
        "minStock": 1,
        "isArchived": False,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }],
    "pagination": {"page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1},
}


class UiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.playwright = sync_playwright().start()
        cls.browser: Browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            headless=True,
            args=["--no-sandbox"],
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.playwright.stop()

    def make_page(
        self,
        *,
        width: int = 375,
        ready_session: bool = True,
        fail_products: int = 0,
        populated_products: bool = False,
        auth_failure: bool = False,
        business_missing: bool = False,
        assistant_summary: dict[str, object] | None = None,
    ) -> tuple[BrowserContext, Page, dict[str, object]]:
        context = self.browser.new_context(
            viewport={"width": width, "height": 812},
            is_mobile=width <= 620,
            has_touch=width <= 620,
        )
        if ready_session:
            context.add_cookies([{
                "name": "lokalbiz_session",
                "value": "qa-session-cookie",
                "url": BASE_URL,
                "httpOnly": True,
                "sameSite": "Lax",
            }])
        context.add_init_script(
            "window.__qaDelayProducts = false;"
            "const originalFetch = window.fetch.bind(window);"
            "window.fetch = async (...args) => {"
            " const requestUrl = typeof args[0] === 'string' ? args[0] : args[0].url;"
            " if (window.__qaDelayProducts && requestUrl.includes('/products')) {"
            "  window.__qaDelayProducts = false;"
            "  await new Promise(resolve => setTimeout(resolve, 600));"
            " }"
            " return originalFetch(...args);"
            "};"
        )
        page = context.new_page()
        state: dict[str, object] = {
            "fail_products": fail_products,
            "auth_failure": auth_failure,
            "logged_in": ready_session,
            "business_missing": business_missing,
            "business_created": False,
            "auth_calls": [],
            "csrf_calls": [],
            "call_order": [],
            "business_cookie_sent": False,
            "business_mutations": [],
            "auth_response_body": None,
            "logout_call": None,
            "assistant_summary": assistant_summary,
            "assistant_calls": [],
        }
        app_origin = f"{urlparse(BASE_URL).scheme}://{urlparse(BASE_URL).netloc}"

        def business_response(route) -> None:
            state["business_cookie_sent"] = bool(route.request.headers.get("cookie"))
            if state["business_missing"] and not state["business_created"]:
                route.fulfill(
                    status=404,
                    content_type="application/json",
                    body=json.dumps({"error": {"code": "BUSINESS_NOT_FOUND", "message": "Usaha belum dibuat."}}),
                )
            elif state["logged_in"] and state["business_cookie_sent"]:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(BUSINESS))
            else:
                route.fulfill(
                    status=401,
                    content_type="application/json",
                    body=json.dumps({"error": {"code": "UNAUTHENTICATED", "message": "Sesi autentikasi diperlukan."}}),
                )

        def auth_api_response(route) -> None:
            path = urlparse(route.request.url).path
            state["call_order"].append(path)
            if path.endswith("/csrf"):
                if not route.request.headers.get("cookie"):
                    route.fulfill(
                        status=401,
                        content_type="application/json",
                        body=json.dumps({"error": {"code": "UNAUTHENTICATED", "message": "Sesi autentikasi diperlukan."}}),
                    )
                    return
                state["csrf_calls"].append({"cookie": route.request.headers.get("cookie")})
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"data": {"csrfToken": "qa-csrf-token"}}))
                return
            if path.endswith("/logout"):
                state["logout_call"] = {
                    "cookie": route.request.headers.get("cookie"),
                    "origin": route.request.headers.get("origin"),
                    "csrf": route.request.headers.get("x-csrf-token"),
                }
                if not state["logout_call"]["cookie"] or state["logout_call"]["origin"] != app_origin or state["logout_call"]["csrf"] != "qa-csrf-token":
                    route.fulfill(
                        status=403,
                        content_type="application/json",
                        body=json.dumps({"error": {"code": "CSRF_TOKEN_INVALID", "message": "Token CSRF tidak valid atau tidak tersedia."}}),
                    )
                    return
                state["logged_in"] = False
                route.fulfill(status=204, headers={"Set-Cookie": "lokalbiz_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})
                return

            auth_call = {"path": path, "body": route.request.post_data_json, "origin": route.request.headers.get("origin")}
            state["auth_calls"].append(auth_call)
            if auth_call["origin"] != app_origin:
                route.fulfill(
                    status=403,
                    content_type="application/json",
                    body=json.dumps({"error": {"code": "ORIGIN_NOT_ALLOWED", "message": "Origin permintaan tidak diizinkan."}}),
                )
                return
            if state["auth_failure"]:
                route.fulfill(
                    status=401,
                    content_type="application/json",
                    body=json.dumps({"error": {"code": "INVALID_CREDENTIALS", "message": "Email atau password tidak valid."}}),
                )
                return
            state["logged_in"] = True
            user = {"id": "qa-user", "email": auth_call["body"].get("email", "qa@example.com")}
            state["auth_response_body"] = {"data": {"user": user}}
            route.fulfill(
                status=201 if path.endswith("/register") else 200,
                content_type="application/json",
                headers={"Set-Cookie": "lokalbiz_session=qa-session-cookie; HttpOnly; SameSite=Lax; Path=/"},
                body=json.dumps(state["auth_response_body"]),
            )

        def business_create_response(route) -> None:
            headers = route.request.headers
            mutation = {
                "path": urlparse(route.request.url).path,
                "cookie": headers.get("cookie"),
                "origin": headers.get("origin"),
                "csrf": headers.get("x-csrf-token"),
            }
            state["business_mutations"].append(mutation)
            if not mutation["cookie"] or mutation["origin"] != app_origin or mutation["csrf"] != "qa-csrf-token":
                route.fulfill(
                    status=403,
                    content_type="application/json",
                    body=json.dumps({"error": {"code": "CSRF_TOKEN_INVALID", "message": "Token CSRF tidak valid atau tidak tersedia."}}),
                )
                return
            input_data = route.request.post_data_json
            state["business_created"] = True
            business = dict(BUSINESS["data"])
            business["name"] = input_data.get("name", "Warung QA")
            route.fulfill(status=201, content_type="application/json", body=json.dumps({"data": business}))

        def business_api_response(route) -> None:
            path = urlparse(route.request.url).path
            if path == "/api/businesses/current":
                business_response(route)
                return
            if route.request.method in {"POST", "PATCH", "DELETE"}:
                headers = route.request.headers
                mutation = {
                    "path": path,
                    "cookie": headers.get("cookie"),
                    "origin": headers.get("origin"),
                    "csrf": headers.get("x-csrf-token"),
                }
                state["business_mutations"].append(mutation)
                if not mutation["cookie"] or mutation["origin"] != app_origin or mutation["csrf"] != "qa-csrf-token":
                    route.fulfill(
                        status=403,
                        content_type="application/json",
                        body=json.dumps({"error": {"code": "CSRF_TOKEN_INVALID", "message": "Token CSRF tidak valid atau tidak tersedia."}}),
                    )
                    return
            if path.endswith("/products"):
                if state["fail_products"]:
                    state["fail_products"] -= 1
                    route.fulfill(
                        status=503,
                        content_type="application/json",
                        body=json.dumps({"error": {"code": "SERVICE_UNAVAILABLE", "message": "Server sementara tidak tersedia."}}),
                    )
                elif route.request.method == "POST":
                    route.fulfill(status=201, content_type="application/json", body=json.dumps({"data": PRODUCT_PAGE["data"][0]}))
                else:
                    payload = PRODUCT_PAGE if populated_products else EMPTY_PAGE
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
                return
            if path.endswith("/inventory/alerts"):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"data": {"items": [], "totalItems": 0}}))
                return
            if path.endswith("/inventory/forecasts"):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"data": {"items": []}}))
                return
            if path.endswith("/reports/sales"):
                query = parse_qs(urlparse(route.request.url).query)
                from_date = query.get("from", ["2026-01-01"])[0]
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({
                        "data": {
                            "period": {
                                "from": from_date,
                                "to": query.get("to", [from_date])[0],
                                "startAt": f"{from_date}T00:00:00.000Z",
                                "endAt": f"{from_date}T00:00:00.000Z",
                                "timeZone": "Asia/Jakarta",
                            },
                            "currency": "IDR",
                            "totalRevenue": 0,
                            "transactionCount": 0,
                            "dailyRevenue": [{"date": from_date, "totalRevenue": 0, "transactionCount": 0}],
                            "topProducts": [],
                        }
                    }),
                )
                return
            if path.endswith("/transactions"):
                if route.request.method == "POST":
                    route.fulfill(
                        status=201,
                        content_type="application/json",
                        body=json.dumps({"data": {
                            "id": "33333333-3333-4333-8333-333333333333",
                            "status": "COMPLETED",
                            "currency": "IDR",
                            "totalAmount": 2500,
                            "createdAt": "2026-01-01T00:00:00.000Z",
                            "items": [{"productId": PRODUCT_ID, "productName": "Kopi", "quantity": 1, "unitPrice": 2500, "lineTotal": 2500}],
                        }}),
                    )
                else:
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(EMPTY_PAGE))
                return
            if path.endswith("/assistant/summaries"):
                if state["assistant_summary"] is not None:
                    state["assistant_calls"].append(route.request.post_data_json)
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({"data": state["assistant_summary"]}),
                    )
                    return
                route.fulfill(
                    status=503,
                    content_type="application/json",
                    body=json.dumps({"error": {"code": "AI_SUMMARY_NOT_CONFIGURED", "message": "Penyedia ringkasan belum dikonfigurasi."}}),
                )
                return
            route.fulfill(
                status=404,
                content_type="application/json",
                body=json.dumps({"error": {"code": "NOT_FOUND", "message": "Endpoint tidak ditemukan."}}),
            )

        page.route("**/api/auth/**", auth_api_response)
        page.route("**/api/businesses", business_create_response)
        page.route("**/api/businesses/**", business_api_response)
        return context, page, state

    def open_dashboard(self, width: int = 375, populated_products: bool = False) -> tuple[BrowserContext, Page, dict[str, object]]:
        context, page, state = self.make_page(width=width, populated_products=populated_products)
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.get_by_role("heading", name="Kabar usaha hari ini").wait_for(timeout=8000)
        return context, page, state

    @staticmethod
    def navigate(page: Page, label: str) -> None:
        mobile_navigation = page.locator(".mobile-nav")
        if mobile_navigation.is_visible():
            mobile_navigation.get_by_role("button", name=label).click()
        else:
            page.locator(".nav-list").get_by_role("button", name=label).click()

    def test_login_failure_is_announced(self) -> None:
        context, page, state = self.make_page(ready_session=False, auth_failure=True)
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_role("heading", name="Masuk ke LokalBiz").wait_for(timeout=5000)
            page.get_by_label("Email").fill("owner@example.com")
            page.get_by_label("Kata sandi").fill("Wrong1234")
            page.get_by_role("button", name="Masuk").click()
            alert = page.get_by_role("alert")
            alert.wait_for(timeout=5000)
            self.assertIn(
                "Email atau password tidak valid",
                alert.inner_text(),
                f"Auth request order={state['call_order']}; auth calls={state['auth_calls']}",
            )
            self.assertEqual(state["auth_calls"][0]["path"], "/api/auth/login")
        finally:
            context.close()

    def test_login_uses_http_only_cookie_and_fetches_csrf_after_success(self) -> None:
        context, page, state = self.make_page(ready_session=False)
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_label("Email").fill("owner@example.com")
            page.get_by_label("Kata sandi").fill("Pass1234")
            page.get_by_role("button", name="Masuk").click()
            page.wait_for_function(
                "() => document.querySelector('.app-shell') || document.querySelector('[role=alert]')",
                timeout=5000,
            )
            if not page.locator(".app-shell").count():
                alert = page.get_by_role("alert").inner_text() if page.get_by_role("alert").count() else "tidak ada alert"
                self.fail(f"Login tidak mencapai dashboard; order={state['call_order']}; alert={alert}")

            login_index = state["call_order"].index("/api/auth/login")
            self.assertIn("/api/auth/csrf", state["call_order"][login_index + 1:])
            self.assertEqual(state["auth_calls"][0]["path"], "/api/auth/login")
            self.assertEqual(set(state["auth_response_body"]["data"]), {"user"})
            self.assertEqual(len(state["csrf_calls"]), 1)
            self.assertTrue(state["business_cookie_sent"])
            storage = page.evaluate("""() => {
              const values = storage => Array.from({length: storage.length}, (_, i) => storage.getItem(storage.key(i)));
              return {
                sessionToken: sessionStorage.getItem('lokalbiz-session-token'),
                localToken: localStorage.getItem('lokalbiz-session-token'),
                storedValues: [...values(sessionStorage), ...values(localStorage)],
                visibleCookie: document.cookie
              };
            }""")
            self.assertIsNone(storage["sessionToken"])
            self.assertIsNone(storage["localToken"])
            self.assertNotIn("qa-session-cookie", storage["storedValues"])
            self.assertNotIn("qa-csrf-token", storage["storedValues"])
            self.assertNotIn("qa-session-cookie", storage["visibleCookie"])
        finally:
            context.close()

    def test_foreign_api_base_in_session_storage_is_ignored(self) -> None:
        context, page, state = self.make_page(ready_session=False)
        external_requests: list[str] = []

        def block_external_api(route) -> None:
            external_requests.append(route.request.url)
            route.abort()

        context.add_init_script(
            "sessionStorage.setItem('lokalbiz-api-base', 'https://attacker.invalid/api');"
        )
        page.route("https://attacker.invalid/**", block_external_api)
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_role("heading", name="Masuk ke LokalBiz").wait_for(timeout=5000)
            page.get_by_label("Email").fill("owner@example.com")
            page.get_by_label("Kata sandi").fill("Pass1234")
            page.get_by_role("button", name="Masuk").click()
            page.wait_for_function(
                "() => document.querySelector('.app-shell') || document.querySelector('[role=alert]')",
                timeout=5000,
            )
            if not page.locator(".app-shell").count():
                alert = page.get_by_role("alert").inner_text() if page.get_by_role("alert").count() else "tidak ada alert"
                self.fail(f"URL API asing dari sessionStorage tidak ditolak; order={state['call_order']}; alert={alert}")

            self.assertEqual(external_requests, [])
            self.assertEqual(state["auth_calls"][0]["path"], "/api/auth/login")
            self.assertIn("/api/auth/csrf", state["call_order"])
            self.assertIsNone(page.evaluate("sessionStorage.getItem('lokalbiz-api-base')"))
        finally:
            context.close()

    def test_registration_then_create_first_business(self) -> None:
        context, page, state = self.make_page(ready_session=False, business_missing=True)
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_role("button", name="Buat akun").click()
            page.get_by_role("heading", name="Buat akun").wait_for(timeout=3000)
            page.get_by_label("Email").fill("new-owner@example.com")
            page.get_by_label("Kata sandi").fill("Pass1234")
            page.get_by_role("button", name="Daftar").click()
            page.wait_for_function(
                "() => document.querySelector('h1')?.textContent === 'Siapkan ruang usaha' || document.querySelector('[role=alert]')",
                timeout=5000,
            )
            if not page.get_by_role("heading", name="Siapkan ruang usaha").count():
                alert = page.get_by_role("alert").inner_text() if page.get_by_role("alert").count() else "tidak ada alert"
                self.fail(f"Register tidak mencapai onboarding usaha; order={state['call_order']}; auth calls={state['auth_calls']}; alert={alert}")
            self.assertEqual(state["auth_calls"][0]["path"], "/api/auth/register")
            register_index = state["call_order"].index("/api/auth/register")
            self.assertIn("/api/auth/csrf", state["call_order"][register_index + 1:])

            page.get_by_label("Nama usaha").fill("Kedai QA")
            page.get_by_label("Zona waktu usaha").fill("Asia/Jakarta")
            page.get_by_role("button", name="Buat ruang usaha").click()
            page.get_by_role("heading", name="Kabar usaha hari ini").wait_for(timeout=5000)
            self.assertTrue(state["business_created"])
            mutation = state["business_mutations"][-1]
            self.assertTrue(mutation["cookie"])
            self.assertEqual(mutation["origin"], f"{urlparse(BASE_URL).scheme}://{urlparse(BASE_URL).netloc}")
            self.assertEqual(mutation["csrf"], "qa-csrf-token")
        finally:
            context.close()

    def test_auth_form_has_accessible_mobile_layout(self) -> None:
        context, page, _ = self.make_page(width=375, ready_session=False)
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_role("heading", name="Masuk ke LokalBiz").wait_for(timeout=5000)
            self.assertEqual(page.locator("h1:visible").count(), 1)
            self.assertTrue(page.get_by_label("Email").is_visible())
            self.assertTrue(page.get_by_label("Kata sandi").is_visible())
            self.assertEqual(page.locator("html").get_attribute("lang"), "id")

            sizes = page.evaluate("({width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth})")
            self.assertLessEqual(sizes["document"], 375, f"Horizontal overflow pada form auth: {sizes}")
            self.assertLessEqual(sizes["body"], 375, f"Body overflow pada form auth: {sizes}")
            undersized = page.locator(".auth-card button:visible").evaluate_all(
                "nodes => nodes.map(node => {const rect = node.getBoundingClientRect(); return {name: node.innerText.trim(), width: Math.round(rect.width), height: Math.round(rect.height)}}).filter(item => item.width < 44 || item.height < 44)"
            )
            self.assertEqual(undersized, [], f"Target sentuh form auth di bawah 44px: {undersized}")
            self.assertEqual(page.locator("main").count(), 1, "Layar auth harus menyediakan landmark main.")
        finally:
            context.close()

    def test_sign_out_sends_cookie_origin_and_csrf(self) -> None:
        context, page, state = self.make_page(width=1365)
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_role("heading", name="Kabar usaha hari ini").wait_for(timeout=5000)
            page.get_by_role("button", name="Keluar", exact=True).click()
            page.get_by_role("heading", name="Masuk ke LokalBiz").wait_for(timeout=5000)
            self.assertTrue(state["logout_call"]["cookie"])
            self.assertEqual(state["logout_call"]["origin"], f"{urlparse(BASE_URL).scheme}://{urlparse(BASE_URL).netloc}")
            self.assertEqual(state["logout_call"]["csrf"], "qa-csrf-token")
            self.assertGreaterEqual(len(state["csrf_calls"]), 1)
        finally:
            context.close()

    def test_loading_error_retry_and_product_empty_states(self) -> None:
        context, page, state = self.open_dashboard()
        try:
            page.evaluate("window.__qaDelayProducts = true")
            self.navigate(page, "Produk & stok")
            page.get_by_role("status").filter(has_text="Memuat produk...").wait_for(timeout=3000)
            page.get_by_text("Belum ada produk", exact=True).wait_for(timeout=5000)

            self.navigate(page, "Ringkasan")
            page.get_by_role("heading", name="Kabar usaha hari ini").wait_for(timeout=5000)
            state["fail_products"] = 1
            self.navigate(page, "Produk & stok")
            alert = page.get_by_role("alert")
            alert.wait_for(timeout=5000)
            self.assertIn("Server sementara tidak tersedia", alert.inner_text())
            page.get_by_role("button", name="Coba lagi").click()
            page.get_by_text("Belum ada produk", exact=True).wait_for(timeout=5000)
        finally:
            context.close()

    def test_empty_sales_picker_and_transaction_history(self) -> None:
        context, page, _ = self.open_dashboard()
        try:
            self.navigate(page, "Jual")
            page.get_by_role("heading", name="Catat penjualan").wait_for(timeout=5000)
            page.get_by_text("Belum ada produk aktif", exact=True).wait_for(timeout=5000)
            page.get_by_text("Belum ada transaksi pada periode ini", exact=True).wait_for(timeout=5000)
            self.assertGreaterEqual(page.get_by_role("status").count(), 2)
        finally:
            context.close()

    def test_sale_success_receipt_is_announced(self) -> None:
        context, page, _ = self.open_dashboard(populated_products=True)
        try:
            self.navigate(page, "Jual")
            page.get_by_role("button", name="Tambah Kopi ke keranjang").click()
            page.get_by_role("button", name="Simpan transaksi").click()
            page.get_by_role("heading", name="Transaksi tersimpan").wait_for(timeout=5000)
            page.get_by_role("status").filter(has_text="Transaksi berhasil dicatat.").wait_for(timeout=3000)
        finally:
            context.close()

    def test_empty_assistant_and_configuration_error_are_announced(self) -> None:
        context, page, _ = self.open_dashboard()
        try:
            self.navigate(page, "Asisten")
            page.get_by_role("heading", name="Asisten bisnis").wait_for(timeout=5000)
            page.get_by_text("Pilih periode untuk mulai", exact=True).wait_for(timeout=3000)
            page.get_by_role("button", name="Buat ringkasan").click()
            alert = page.get_by_role("alert")
            alert.wait_for(timeout=5000)
            self.assertIn("Asisten belum dihubungkan", alert.inner_text())
        finally:
            context.close()

    def test_assistant_displays_exclusive_to_as_included_through(self) -> None:
        context, page, state = self.make_page(assistant_summary={
            "period": {"from": "2026-11-01", "to": "2026-11-02", "timeZone": "Asia/Jakarta"},
            "summary": "Ringkasan sintetis untuk 1 November 2026.",
            "dataStatus": "READY",
            "highlights": [],
        })
        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.get_by_role("heading", name="Kabar usaha hari ini").wait_for(timeout=8000)
            self.navigate(page, "Asisten")
            page.get_by_label("Dari tanggal").fill("2026-11-01")
            page.get_by_label("Sampai tanggal").fill("2026-11-01")
            page.get_by_role("button", name="Buat ringkasan").click()
            result = page.locator(".assistant-result")
            result.wait_for(timeout=5000)
            result_text = result.inner_text()
            self.assertIn("periode 1 nov 2026 sampai 1 nov 2026", result_text.lower())
            self.assertNotIn("2 nov 2026", result_text.lower())
            self.assertEqual(state["assistant_calls"], [{"from": "2026-11-01", "to": "2026-11-02"}])
        finally:
            context.close()

    def test_empty_dashboard_uses_final_report_contract(self) -> None:
        context, page, _ = self.open_dashboard()
        try:
            self.assertTrue(
                page.get_by_text("Mulai dengan produk pertama", exact=True).is_visible(),
                "Respons PRD totalRevenue/transactionCount harus memicu state first-run dashboard.",
            )
        finally:
            context.close()

    def test_empty_report_uses_final_report_contract(self) -> None:
        context, page, _ = self.open_dashboard()
        try:
            self.navigate(page, "Laporan")
            page.get_by_role("heading", name="Laporan penjualan").wait_for(timeout=5000)
            self.assertTrue(
                page.get_by_text("Belum ada penjualan pada periode ini", exact=True).is_visible(),
                "Respons PRD dengan transactionCount=0 harus menampilkan empty state laporan.",
            )
        finally:
            context.close()

    def test_mobile_layout_accessibility_and_no_overflow(self) -> None:
        context, page, _ = self.open_dashboard(width=375)
        try:
            self.assertTrue(page.locator(".mobile-nav").is_visible())
            self.assertEqual(page.locator("main").count(), 1)
            self.assertEqual(page.locator("h1:visible").count(), 1)
            self.assertEqual(page.locator("html").get_attribute("lang"), "id")

            page.evaluate("document.activeElement.blur()")
            page.keyboard.press("Tab")
            self.assertEqual(page.evaluate("document.activeElement.className"), "skip-link")

            missing_names = page.locator("button:visible").evaluate_all(
                "nodes => nodes.filter(node => !(node.getAttribute('aria-label') || node.innerText.trim())).map(node => node.outerHTML)"
            )
            self.assertEqual(missing_names, [], "Setiap tombol yang terlihat harus memiliki nama aksesibel.")

            for width in (375, 768, 1365):
                page.set_viewport_size({"width": width, "height": 812})
                for label, heading in (
                    ("Ringkasan", "Kabar usaha hari ini"),
                    ("Produk & stok", "Produk & stok"),
                    ("Jual", "Catat penjualan"),
                    ("Laporan", "Laporan penjualan"),
                    ("Asisten", "Asisten bisnis"),
                ):
                    self.navigate(page, label)
                    page.get_by_role("heading", name=heading).wait_for(timeout=5000)
                    sizes = page.evaluate("({width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth})")
                    self.assertLessEqual(sizes["document"], width, f"Horizontal overflow pada {width}px ({label}): {sizes}")
                    self.assertLessEqual(sizes["body"], width, f"Body overflow pada {width}px ({label}): {sizes}")
        finally:
            context.close()

    def test_mobile_product_action_targets_are_at_least_44px(self) -> None:
        context, page, _ = self.open_dashboard(width=375, populated_products=True)
        try:
            self.navigate(page, "Produk & stok")
            page.get_by_text("Kopi", exact=True).wait_for(timeout=5000)
            undersized = page.locator(".table-actions button:visible").evaluate_all(
                "nodes => nodes.map(node => {const rect = node.getBoundingClientRect(); return {name: node.innerText.trim(), width: Math.round(rect.width), height: Math.round(rect.height)}}).filter(item => item.width < 44 || item.height < 44)"
            )
            self.assertEqual(undersized, [], f"Target aksi produk di bawah 44px: {undersized}")
        finally:
            context.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

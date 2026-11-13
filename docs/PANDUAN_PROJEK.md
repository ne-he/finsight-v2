# FinSight v2: tanya jawab atas laporan tahunan perusahaan publik AS, dengan setiap jawaban menunjuk ke halaman sumbernya

| Sekilas | |
|---|---|
| Apa | Aplikasi web RAG (retrieval-augmented generation) untuk bertanya soal isi laporan tahunan SEC 10-K. Jawaban hanya disusun dari teks laporan, diberi sitasi sampai level bagian (Item), atau ditolak dengan jujur kalau laporan tidak memuat jawabannya. |
| Untuk siapa | Orang yang perlu membaca 10-K tapi tidak punya waktu membaca 100+ halaman: analis, mahasiswa keuangan, investor ritel. Untuk portfolio, sasarannya rekruter dan engineer yang menilai kemampuan membangun sistem AI sampai production. |
| Status | Live dan menjawab. Mode tamu `/try` sudah ada di kode production, tapi tombolnya masih tersembunyi sampai migrasi `0006_guest_usage.sql` dijalankan di Supabase. |
| Link live | https://finsight-v2-nine.vercel.app (hati-hati: `finsight-v2.vercel.app` tanpa `-nine` itu milik orang lain) |
| Repo | https://github.com/ne-he/finsight-v2 |
| Teknologi utama | Next.js 16.4.6 (App Router), TypeScript, Supabase (Postgres, pgvector, Auth, RLS), Gemini API lewat REST, Vercel, Vitest, GitHub Actions |
| Terakhir diperbarui | Kode: 11 Nov 2026 (commit `f93c520`). Dokumen ini: 12 Nov 2026. |

## 1. Projek ini tentang apa

Bayangkan kamu punya tiga buku tebal, masing-masing ratusan halaman, berisi laporan tahunan NVIDIA, Apple, dan Microsoft. Seseorang bertanya, "Apa risiko terbesar NVIDIA?" Kamu tidak membaca ulang semua buku. Kamu buka daftar isi, lompat ke bab Risk Factors, tandai beberapa paragraf yang relevan, lalu menjawab sambil menunjuk, "Ini, halaman sekian."

FinSight melakukan persis itu, tapi otomatis. Laporan dipotong jadi potongan kecil (chunk), tiap potongan diberi "sidik makna" berupa deretan angka (embedding), dan semuanya disimpan di database. Saat ada pertanyaan, sistem mencari potongan yang paling mirip maknanya dan paling cocok kata kuncinya, menyerahkan potongan itu ke model bahasa Gemini, lalu menyuruh Gemini menjawab **hanya** dari potongan tersebut sambil mencantumkan sitasi seperti `[NVDA FY2026 * Item 1A. Risk Factors]`.

Bedanya dengan chatbot biasa: chatbot menjawab dari ingatannya, yang bisa basi dan tidak bisa dilacak. FinSight menjawab dari dokumen, dan kalau dokumennya tidak memuat jawaban, dia bilang tidak tahu. Di layar, potongan sumber ditampilkan di panel samping, jadi pembaca bisa mengecek sendiri apakah jawabannya benar.

Korpus saat ini berisi tiga laporan: NVDA FY2026, AAPL FY2025, dan MSFT FY2026, total 936 chunk.

## 2. Masalah yang mau diselesaikan

Laporan 10-K adalah sumber paling resmi tentang kondisi perusahaan publik AS, tapi panjang dan kering. Bertanya ke chatbot umum soal isinya punya tiga risiko nyata. Model bisa mengarang angka yang terdengar meyakinkan. Model tidak bisa menunjukkan dari mana faktanya berasal. Model juga cenderung tetap menjawab walaupun tidak tahu.

Untuk domain keuangan, jawaban yang salah tapi terdengar benar lebih berbahaya daripada tidak ada jawaban. Jadi FinSight dirancang dengan tiga pegangan: fakta wajib berasal dari teks laporan, setiap klaim wajib bisa diklik ke sumbernya, dan ada "gerbang keyakinan" yang menolak pertanyaan kalau hasil pencarian terlalu lemah.

Ada masalah kedua yang lebih teknis dan lebih personal. Versi 1 (Python FastAPI, repo `RAG_businessAnalysis_assist`) sudah jalan dan teruji, tapi tidak pernah di-deploy karena butuh server yang menjalankan proses Python terus-menerus. Dengan budget Rp 0, opsi hosting gratis selalu menyisakan pertanyaan soal kartu kredit atau batas plan. Versi 2 ditulis ulang total sebagai satu aplikasi Next.js di Vercel supaya masalah hosting itu hilang sepenuhnya (`docs/ARCHITECTURE.md` bagian 1).

## 3. Cara kerjanya, langkah demi langkah

### Jalur bertanya

Kita ikuti satu pertanyaan contoh: **"Compare the revenue drivers of NVIDIA and Apple."** Pertanyaan ini sengaja dipilih karena dulu gagal (lihat bagian 6) dan sekarang lolos.

```
Browser (chat-view.tsx)
  -> POST /api/chat  (atau /api/guest/chat untuk tamu)
  -> cek login, cek ukuran pesan, hitung kuota di database
  -> answer-stream.ts: loadFilings -> retrieve
       -> detectFilters: ketemu AAPL dan NVDA
       -> embed pertanyaan sekali (Gemini, 768 dimensi)
       -> fs_match_chunks untuk AAPL, fs_match_chunks untuk NVDA
       -> balanceAcross: selang-seling hasilnya, total 6 chunk
       -> topCosine >= 0,66 ? lanjut : tandai lemah
  -> kirim event "sources" ke browser
  -> streamAnswer ke Gemini (rantai 4 model)
  -> kirim event "token" satu per satu
  -> simpan ke fs_messages (tamu: tidak disimpan)
  -> kirim event "done"
```

**Langkah 1, browser mengirim.** Komponen `src/components/chat-view.tsx` mengirim `message` dan `history` ke `/api/chat`. Kalau halamannya `/try`, endpoint-nya `/api/guest/chat`.

**Langkah 2, penjagaan di route.** `src/app/api/chat/route.ts` memastikan pengguna sudah login. `parseQuestion` menolak pertanyaan kosong, di atas 2.000 karakter, atau riwayat yang terlalu panjang. Lalu fungsi database `fs_bump_usage` menaikkan hitungan harian dan memeriksa batas dalam satu statement (default 40 per user dan 400 total per hari). Semua pengecekan murah ini terjadi sebelum ada panggilan ke Gemini yang memakan kuota.

**Langkah 3, memahami pertanyaan.** `detectFilters` di `src/lib/rag/filters.ts` membangun tabel alias dari laporan yang sudah siap: "nvidia" dan "nvda" mengarah ke NVDA, "apple" ke AAPL. Tahun juga dideteksi, tapi hanya tahun yang ada di korpus. Kalau filternya tidak cocok dengan laporan mana pun, filter dibuang dan pencarian berjalan tanpa filter.

**Langkah 4, mengubah pertanyaan jadi vektor.** `embed` di `src/lib/gemini.ts` memanggil `gemini-embedding-001` dengan `outputDimensionality: 768`, lalu menormalkan vektornya. Satu vektor ini dipakai untuk semua pencarian berikutnya, jadi pertanyaan perbandingan tidak menambah biaya embedding.

**Langkah 5, pencarian hybrid di Postgres.** Karena ada dua perusahaan, `retrieve` di `src/lib/rag/retrieve.ts` menjalankan `fs_match_chunks` sekali untuk AAPL dan sekali untuk NVDA, masing-masing meminta 3 chunk (`perListQuota`: 6 dibagi 2). Di dalam SQL (`supabase/migrations/0003_search.sql`) terjadi ini:

1. Lengan dense: 10 chunk terdekat menurut jarak cosine, dibantu index HNSW.
2. Lengan sparse: 10 chunk terbaik menurut full-text search Postgres (`websearch_to_tsquery` dan `ts_rank_cd`).
3. Dua daftar digabung dengan full outer join, lalu diberi skor Reciprocal Rank Fusion: `1/(60 + peringkat)` dari tiap lengan, dijumlahkan.
4. Diurutkan, diambil sebanyak `final_k`, dan setiap baris membawa `top_cosine`, yaitu cosine dense terbaik sebelum fusi.

**Langkah 6, menyeimbangkan.** `balanceAcross` di `src/lib/rag/balance.ts` menyusun hasil secara bergiliran: terbaik AAPL, terbaik NVDA, kedua AAPL, kedua NVDA, dan seterusnya. Hasilnya 6 chunk dengan kedua perusahaan pasti terwakili.

**Langkah 7, gerbang keyakinan.** Nilai `topCosine` terbaik dibandingkan dengan `CONFIDENCE_THRESHOLD = 0.66` di `src/config.ts`. Di bawah itu, pertanyaan ditandai `gated`, dan prompt ke Gemini diberi bendera `[WEAK RETRIEVAL]` supaya Gemini menjawab "tidak ditemukan di laporan".

**Langkah 8, sumber dikirim duluan.** Sebelum Gemini menulis satu kata pun, browser sudah menerima event `sources` berisi daftar bagian yang dikutip beserta teks potongannya (`sourcesOf`). Panel bukti di kanan langsung terisi.

**Langkah 9, Gemini menulis jawaban.** `buildUserTurn` di `src/lib/rag/prompt.ts` membungkus 6 potongan sebagai "Excerpt 1" sampai "Excerpt 6", masing-masing dengan tag sitasinya. `SYSTEM_PROMPT` melarang membulatkan atau mengarang angka, mewajibkan sitasi tepat setelah klaim, dan menyuruh menjawab dalam bahasa yang dipakai penanya. `streamAnswer` mengirim semua ini ke Gemini dengan `thinkingBudget: 0` (model tidak perlu "berpikir" lama, tugasnya cuma merangkum konteks yang sudah ditemukan). Ada rantai empat model: `gemini-2.5-flash`, `gemini-3.6-flash`, `gemini-flash-latest`, `gemini-2.5-flash-lite`. Tiap model diberi 6 detik untuk mengeluarkan token pertama. Kalau kena kuota, error 5xx, nama model sudah pensiun (404), atau diam lebih dari 6 detik, sistem pindah ke model berikutnya. Perpindahan ini hanya terjadi sebelum token pertama keluar.

**Langkah 10, kalau Gemini gagal total.** Kalau semua model gagal sebelum ada teks, `extractiveAnswer` mengutip langsung 3 potongan teratas (maksimal 700 karakter per potongan) dengan label jelas bahwa ini kutipan, bukan rangkuman. Sitasi tetap utuh. Kalau gagal di tengah jawaban, browser menerima event `error` dan jawaban ditandai terpotong.

**Langkah 11, simpan dan selesai.** Untuk user login, pertanyaan dan jawaban disimpan ke `fs_conversations` dan `fs_messages`, lengkap dengan sitasi, `top_cosine`, `gated`, `degraded`, dan `latency_ms`. Tamu tidak disimpan sama sekali. Terakhir dikirim event `done`.

**Langkah 12, tampilan.** `src/lib/answer-format.ts` mengubah tiap tag sitasi jadi tombol bernomor. Klik tombol membuka potongan sumbernya, dan `src/lib/highlight.ts` menyorot kalimat yang paling banyak berbagi kata dengan klaim. Sorotan ini diberi label perkiraan dan tidak muncul kalau tumpang tindihnya tipis, misalnya saat jawaban berbahasa Indonesia. `match-meter.tsx` menampilkan skor kecocokan terbaik terhadap garis 0,66.

### Jalur ingest (memasukkan laporan baru)

Satu laporan 10-K menghasilkan ratusan chunk, dan tiap chunk butuh satu panggilan embedding. Itu tidak muat dalam satu request serverless yang dibatasi 30 detik. Jadi ingest dibuat sebagai mesin status yang bisa dilanjutkan (`src/lib/ingest.ts`):

```
queued -> fetching -> chunking -> embedding -> ready
              |           |            |
              +-----------+------------+--> failed
```

1. Admin mengetik ticker di halaman `/admin`. `/api/admin/ingest/start` membuat baris job di `fs_ingest_jobs`.
2. `fetchLatestTenK` di `src/lib/rag/edgar.ts` mencari 10-K terbaru di SEC EDGAR, mengunduh HTML-nya, dan mengubahnya jadi teks dengan stripper regex buatan sendiri (lebih hemat memori daripada parser DOM). Teks disimpan di `fs_filing_text`.
3. Browser admin lalu memanggil `/api/admin/ingest/step` berulang kali. Tahap chunking memecah teks per Item 10-K (`sections.ts`), lalu per paragraf dengan ukuran 1.200 karakter dan overlap 200 (`chunking.ts`). Chunk disisipkan dengan embedding kosong, jadi chunk yang belum selesai tidak ikut dicari.
4. Tahap embedding memproses 12 chunk per panggilan. Sebelum memanggil Gemini, sistem mengecek `fs_embedding_cache` berdasarkan hash SHA-256 teks. Kalau teks yang sama pernah di-embed, vektornya dipakai ulang.
5. Setelah semua chunk punya embedding, status jadi `ready` dan laporan muncul di pencarian.

Kalau tab ditutup di tengah jalan, job berhenti tapi tidak hilang. Ingest juga bisa dijalankan dari terminal dengan `npm run ingest -- NVDA AAPL`.

## 4. Peta kode: folder dan file penting

| Path | Isinya apa |
|---|---|
| `src/config.ts` | Semua angka tuning: model, dimensi 768, chunk 1.200/200, k = 6, RRF 60, ambang 0,66, batch ingest 12. Tidak ada secret. |
| `src/lib/env.ts` | Validasi environment variable dengan zod, semua nilai di-trim. |
| `src/lib/gemini.ts` | Embedding dan streaming jawaban lewat REST, rantai fallback 4 model, batas 6 detik token pertama, pesan error yang aman untuk user. |
| `src/lib/answer-stream.ts` | Validasi pertanyaan, retrieval, streaming SSE, jawaban darurat, penyimpanan. Dipakai bersama oleh jalur login dan tamu. |
| `src/lib/guest.ts` | Ambil IP klien, bikin ID pengunjung dengan HMAC harian, cek apakah migrasi 0006 sudah jalan. |
| `src/lib/rag/retrieve.ts` | Orkestrasi pencarian, pencarian per perusahaan, gerbang keyakinan, pengelompokan sumber. |
| `src/lib/rag/filters.ts` | Deteksi perusahaan dan tahun dari teks pertanyaan. |
| `src/lib/rag/balance.ts` | Penggabungan bergiliran untuk pertanyaan perbandingan. |
| `src/lib/rag/sections.ts` | Deteksi batas Item 10-K, membuang entri daftar isi dan header halaman berulang. |
| `src/lib/rag/chunking.ts` | Pemotongan per paragraf dengan overlap, ID chunk deterministik. |
| `src/lib/rag/edgar.ts` | Ambil 10-K dari SEC EDGAR dan ubah HTML jadi teks. |
| `src/lib/rag/prompt.ts` | System prompt, pembungkus konteks, format sitasi, jawaban darurat. |
| `src/lib/ingest.ts` | Mesin status ingest dan cache embedding. |
| `src/lib/sse.ts` | Parser SSE yang tahan event terpotong antar paket jaringan. |
| `src/app/api/chat/route.ts`, `src/app/api/guest/chat/route.ts` | Endpoint tanya untuk user login dan untuk tamu. |
| `src/app/api/admin/ingest/` | Endpoint `start` dan `step` untuk ingest, khusus admin. |
| `src/app/api/keep-alive/route.ts` | Ping database supaya Supabase tidak tertidur. Tidak memanggil Gemini. |
| `src/components/chat-view.tsx`, `src/components/chat/` | Layar chat, panel bukti, dan meter kecocokan. |
| `supabase/migrations/` | 0001 skema, 0002 RLS, 0003 fungsi pencarian, 0004 batas harian, 0005 admin pertama, 0006 kuota tamu. |
| `scripts/` | `verify-setup`, `inspect-filing`, `ingest`, `run-eval`, `promote-admin`. |
| `evals/golden-set.json` | 22 pertanyaan uji dengan perusahaan yang diharapkan. |
| `evals/results/` | Laporan eval bertanggal 20, 21, dan 22 Sep 2026. |
| `tests/` | 11 file Vitest, total 91 test, semua offline. |
| `.github/workflows/` | `ci.yml` (test, typecheck, lint, build) dan `keep-alive.yml`. |

## 5. Teknologi yang dipakai dan kenapa

| Teknologi | Dipakai untuk | Kenapa ini |
|---|---|---|
| Next.js 16 App Router | Halaman dan API dalam satu deployment | Tidak perlu backend terpisah, tidak ada CORS, satu tempat deploy. |
| Vercel (Hobby) | Hosting | Gratis tanpa kartu, sudah terbukti di projek lain. Route dibatasi `maxDuration = 30`. |
| Supabase Postgres + pgvector | Vektor, full-text, riwayat chat, kuota | Pencarian vektor dan relasional di satu database. Pakai project yang sama dengan app Ask Nemi karena slot free tier sudah penuh, semua objek berawalan `fs_`. |
| Supabase Auth + RLS | Login dan isolasi data | Browser memegang anon key, jadi RLS memastikan user tidak bisa membaca percakapan orang lain walaupun ada route yang lupa cek. |
| Gemini API lewat REST | Embedding dan jawaban | Tanpa SDK karena butuh `outputDimensionality` dan `thinkingConfig`, yang canggung lewat SDK JavaScript. Bundle juga lebih kecil. |
| `gemini-embedding-001` 768 dimensi | Embedding | Native 3.072 dimensi, dipotong ke 768 supaya kolom vektor ringan untuk free tier. |
| Vitest dan GitHub Actions | Unit test, CI, keep-alive cadangan | Gratis, offline, dan CI tidak memegang secret production. |

## 6. Angka dan bukti

| Angka | Nilai | Sumber |
|---|---|---|
| Korpus | NVDA FY2026, AAPL FY2025, MSFT FY2026, 936 chunk | `README.md`, `evals/results/2026-09-22.md` |
| Golden set | 22 pertanyaan: 18 bisa dijawab, 4 di luar cakupan | `evals/golden-set.json` |
| Retrieval hit-rate@6 | 18/18 | `evals/results/2026-09-22.md` |
| Akurasi gerbang out-of-scope | 4/4 | `evals/results/2026-09-22.md` |
| False refusal | 0 | `evals/results/2026-09-22.md` |
| Rata-rata top cosine | 0,7627 | `evals/results/2026-09-22.md` |
| Rentang cosine pertanyaan valid | 0,707 sampai 0,815 | `evals/results/2026-09-22.md` |
| Rentang cosine pertanyaan di luar cakupan | 0,472 sampai 0,612, celah 0,095 | `evals/results/2026-09-22.md`, `README.md` |
| Ambang gerbang | 0,66 (titik tengah celah) | `src/config.ts` |
| Eval pertama | 13/14, satu gagal di perbandingan pendapatan NVIDIA dan Apple | `evals/results/2026-09-20.md` |
| Lama ingest | NVDA 362 chunk dalam 404 detik, AAPL 220 dalam 237 detik, MSFT 354 dalam 361 detik | `README.md` |
| Latensi sebelum dan sesudah fix | 97 detik menjadi 4 detik untuk pertanyaan yang sama | `docs/ARCHITECTURE.md` bagian 6, commit `0b7d52f` |
| Unit test | 91 lolos, 11 file | folder `tests/` (hitungan `it(` per file) |
| Pertanyaan bahasa Indonesia | 2 dari 2 diarahkan ke laporan yang benar | `evals/results/2026-09-22.md` (`id-nvda-risk`, `id-aapl-segments`) |

Cara membaca angka ini dengan jujur: semuanya mengukur **retrieval**, yaitu apakah potongan yang benar masuk ke 6 teratas dan apakah pertanyaan ngawur ditolak. Kualitas jawaban yang ditulis Gemini (faithfulness) belum pernah diukur. Golden set 22 pertanyaan juga kecil, jadi 18/18 artinya "lolos uji yang ada", bukan "sempurna".

## 7. Keputusan desain penting

**Satu deployment, bukan frontend dan backend terpisah.** Pilihan lain adalah tetap memakai engine Python v1 di belakang frontend Next.js. Itu menyelamatkan engine yang sudah terukur, tapi mengembalikan masalah hosting yang justru mau dihilangkan. Trade-off-nya: setiap jawaban harus selesai di bawah 30 detik.

**Ranking pindah ke dalam Postgres.** v1 menyimpan seluruh index di memori proses, sesuatu yang tidak mungkin di serverless. Jadi fusi dense dan sparse dipindah ke fungsi SQL `fs_match_chunks`. Untungnya, filter perusahaan diterapkan di dalam ranking, jadi hasil tidak pernah kurang dari k. Ruginya: lengan kata kunci memakai `ts_rank_cd`, bukan BM25, tidak ada reranker, dan logika SQL lebih susah di-unit-test.

**Ambang 0,66 hasil ukur, bukan warisan.** v1 memakai 0,68. Setelah MSFT masuk, pertanyaan valid terendah (perbandingan tiga perusahaan) mencetak 0,707, hanya 0,027 di atas 0,68. Ambang dipindah ke titik tengah celah antara 0,612 dan 0,707 supaya margin di kedua sisi seimbang.

**Satu pencarian per perusahaan untuk perbandingan.** Satu pencarian atas dua laporan dimenangkan laporan yang kebetulan memakai kata paling mirip. Menaikkan k tidak menolong karena laporan dominan ikut mengambil slot tambahan. Biayanya n kali round trip ke database, hanya untuk pertanyaan perbandingan, tanpa embedding tambahan.

**Fallback model hanya sebelum token pertama.** Kalau model diganti setelah user melihat separuh jawaban, teks di layar akan dobel. Jadi kegagalan di tengah jalan dilaporkan sebagai jawaban terpotong, bukan diulang diam-diam.

**Jawaban darurat berupa kutipan.** Retrieval tidak bergantung pada Gemini untuk generasi. Kalau Gemini mati, potongan yang benar sudah ditemukan, jadi lebih baik ditampilkan sebagai kutipan berlabel daripada layar kosong. Kegagalan yang dicegah ini pernah terjadi di v1: sitasi muncul, lalu tidak ada apa-apa lagi selamanya.

**Ingest digerakkan browser admin, bukan cron.** Cron di Vercel Hobby hanya sekali sehari, jadi satu ingest akan makan berminggu-minggu. Loop dari browser tidak butuh jaminan apa pun dari platform dan memberi progress bar sungguhan. Trade-off-nya, admin harus membiarkan tab terbuka.

**Kuota dan peran di database.** Penghitung di memori akan reset setiap kali Vercel mengganti instance, jadi kuota disimpan di tabel dan dinaikkan plus dicek dalam satu statement. Peran admin tidak bisa ditulis dari klien. Akun pertama yang mendaftar otomatis jadi admin (migrasi 0005), dengan lock tabel supaya dua pendaftaran bersamaan tidak sama-sama jadi admin.

**Mode tamu tanpa menyimpan IP.** ID pengunjung adalah HMAC dari tanggal UTC dan IP, dengan kunci yang hanya ada di server. ID tidak bisa dibalik jadi IP, dan karena tanggal ikut di-hash, pengunjung yang sama tidak bisa dihubungkan dari hari ke hari.

## 8. Update terbaru

**20 Sep 2026.** Rewrite dimulai. Inti retrieval, skema, API route, antarmuka minimal, skrip setup, ingest dari terminal, dan harness eval masuk dalam satu hari. Eval pertama: 13/14 dengan dua laporan.

**21 Sep 2026.** Bug perbandingan diperbaiki dengan pencarian per perusahaan (`023da71`). Jawaban mulai di-parse jadi paragraf, list, dan tag sitasi.

**22 Sep 2026.** MSFT dan perbandingan tiga perusahaan masuk golden set (`ddb5eac`). Ambang diturunkan ke 0,66 berdasarkan celah terukur (`4ae1ea8`).

**23 Sep 2026.** Desain "kertas dan tinta" dan panel bukti dibangun, app di-deploy ke URL publik. Batas fungsi Vercel Hobby dipastikan 300 detik dengan fluid compute, tapi route sengaja tetap 30 detik.

**12 Okt 2026.** Next.js naik ke 16.3.8 untuk menutup advisory RCE di `next/og` dan SSRF di image optimizer (`3c9961a`).

**11 Nov 2026, bug latensi.** Satu pertanyaan sempat makan 97 detik di lokal. Penyebabnya: `gemini-2.5-flash` membalas 503, lalu `gemini-flash-latest` menerima request tapi diam lebih dari 45 detik. Di Vercel, route dipotong di 30 detik, jadi user tidak dapat jawaban apa pun. Fix di commit `0b7d52f`: tiap model diberi 6 detik untuk mengeluarkan token pertama sebelum pindah ke model berikutnya, dan model yang membalas 404 karena dipensiunkan juga dilewati. Rantainya `gemini-2.5-flash`, `gemini-3.6-flash`, `gemini-flash-latest`, `gemini-2.5-flash-lite`. Setelah fix, pertanyaan yang sama selesai 4 detik. Perilaku ini dikunci oleh `tests/gemini-fallback.test.ts`: model yang diam ditinggal, model 404 dilewati, API key salah tidak dicoba ulang.

**11 Nov 2026, mode tamu.** Commit `42268ef` menambah halaman `/try`. Pengunjung bisa bertanya tanpa akun, 5 pertanyaan per pengunjung per hari dan 80 total tamu per hari (diatur lewat `GUEST_LIMIT_PER_VISITOR` dan `GUEST_LIMIT_DAILY`). Hitungan dilakukan di database lewat `fs_bump_guest_usage`, ikut menambah batas global, dan tidak ada percakapan yang disimpan. Riwayat chat tamu dibatasi 12 pesan. Retrieval dan streaming dipindah ke `src/lib/answer-stream.ts` supaya jalur tamu dan login memakai pipeline yang identik. SQL migrasi sudah diuji di Postgres (PGlite). Kode sudah live, tapi tombolnya **masih tersembunyi** karena `guestModeAvailable()` mengecek tabel `fs_guest_usage`, dan migrasi `0006_guest_usage.sql` sengaja belum dijalankan di Supabase.

**11 Nov 2026, keamanan.** Next.js naik ke 16.4.6 (`f93c520`) karena advisory critical di rentang 16.0.0 sampai 16.4.0. Semua 91 unit test lolos, CI hijau, deploy Vercel sukses.

## 9. Batasan jujur dan yang belum dikerjakan

- **Faithfulness jawaban belum diukur.** Retrieval terukur, tapi belum ada bukti seberapa sering Gemini menulis klaim yang tidak didukung potongannya. Menilainya butuh LLM judge dan kuota generasi yang tidak cukup dalam satu hari di free tier.
- **Golden set kecil.** 22 pertanyaan, 3 perusahaan. Cukup untuk menangkap regresi besar, belum cukup untuk klaim statistik.
- **Tidak ada integration test ke database live.** Unit test hanya menutup logika murni. Jalur database dicek manual lewat `npm run verify` dan eval.
- **Prompt injection belum dimitigasi.** Teks dari SEC masuk ke konteks model. Sumbernya berisiko rendah, tapi system prompt bukan batas keamanan.
- **Tidak ada reranker.** Kualitas urutan bergantung penuh pada RRF dense plus `ts_rank_cd`.
- **Satu tahun per perusahaan.** Skema mendukung banyak tahun, tapi alur ingest hanya mengambil 10-K terbaru.
- **Free tier rapuh.** Kuota Gemini per model kecil, dan nama model bisa dipensiunkan Google sewaktu-waktu. Rantai fallback mengurangi risikonya, tidak menghapusnya.
- **Kapasitas penyimpanan Supabase** belum dicek `[?]` (masih tercatat sebagai pertanyaan terbuka di `docs/ARCHITECTURE.md` bagian 9).

## 10. Cara menjalankan dan deploy

Persiapan lokal:

```bash
npm install
cp .env.example .env.local
```

Isi `.env.local` dengan variabel berikut (nilainya jangan pernah di-commit):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (hanya server, juga dipakai sebagai kunci HMAC tamu)
- `GEMINI_API_KEY`
- `EDGAR_USER_AGENT` (SEC mewajibkan User-Agent berisi kontak)
- Opsional: `DAILY_LIMIT_PER_USER` (default 40), `DAILY_LIMIT_GLOBAL` (400), `GUEST_LIMIT_PER_VISITOR` (5), `GUEST_LIMIT_DAILY` (80), `CRON_SECRET`

Jalankan SQL di `supabase/migrations/` berurutan dari 0001 lewat SQL editor Supabase, lalu:

```bash
npm run verify
npm run dev
```

Akun pertama yang mendaftar otomatis jadi admin. Perintah harian lain:

| Perintah | Fungsi |
|---|---|
| `npm run inspect -- NVDA` | Parse laporan asli dan laporkan section serta chunk, tanpa memakai kuota |
| `npm run ingest -- NVDA AAPL` | Ingest dari terminal |
| `npm run eval -- --write` | Ukur retrieval dan tulis laporan bertanggal ke `evals/results/` |
| `npm test` | 91 unit test, offline |
| `npm run typecheck`, `npm run lint`, `npm run build` | Pengecekan yang sama dengan CI |
| `npm run promote -- email` | Jadikan akun lain admin |

Deploy: app berjalan di Vercel dengan environment variable yang sama diisi di dashboard Vercel. Cara deploy dipicu (otomatis dari push ke `main` atau manual) tidak tercatat di repo `[?]`. Cron Vercel memanggil `/api/keep-alive` setiap hari jam 06.00 UTC (`vercel.json`), dan GitHub Actions `keep-alive.yml` jadi cadangan setiap 3 hari jam 07.00 UTC dengan secret `APP_URL` dan `CRON_SECRET`. Ini perlu karena Supabase free tier menidurkan project setelah sekitar tujuh hari tanpa aktivitas.

Untuk menyalakan mode tamu: jalankan isi `supabase/migrations/0006_guest_usage.sql` di SQL editor Supabase. Status ketersediaan di-cache 5 menit per instance, jadi tombol bisa butuh beberapa menit untuk muncul.

## 11. Cara menjelaskan ke rekruter

### Pitch 30 detik (Indonesia)

"FinSight itu sistem tanya jawab atas laporan tahunan 10-K perusahaan publik AS. Bedanya dengan chatbot biasa, jawabannya hanya boleh dari teks laporan, tiap klaim punya sitasi yang bisa diklik ke paragraf sumbernya, dan kalau laporannya tidak memuat jawaban, sistem menolak. Saya tulis ulang dari versi Python jadi satu app Next.js di Vercel dengan Supabase pgvector, pencarian hybrid vektor plus kata kunci yang digabung dengan RRF di dalam SQL. Retrieval-nya saya ukur pakai golden set: 18 dari 18 pertanyaan dapat dokumen yang benar, 4 dari 4 pertanyaan di luar cakupan ditolak, dan ambang penolakannya saya pilih dari data, bukan tebakan."

### Pitch 30 detik (English)

"FinSight is a question answering system over SEC 10-K annual reports. Unlike a chatbot, it answers only from the filing text, every claim carries a clickable citation back to the source passage, and it refuses when the filings do not support an answer. I rewrote it from a Python service into a single Next.js app on Vercel, with Supabase pgvector and hybrid vector plus keyword search fused by RRF inside SQL. I measured retrieval on a golden set: 18 of 18 answerable questions retrieve the right filing, 4 of 4 out-of-scope questions are refused, and the refusal threshold was chosen from that data rather than guessed."

### Pertanyaan yang mungkin ditanya

**1. Kenapa tidak langsung pakai ChatGPT atau Gemini saja?**
Model umum menjawab dari ingatan yang bisa basi dan tidak bisa menunjukkan sumbernya. Di domain keuangan, angka yang salah tapi meyakinkan lebih berbahaya daripada tidak ada jawaban. FinSight memaksa jawaban berasal dari potongan laporan dan menampilkan potongan itu di samping jawaban.

**2. Kenapa hybrid search, bukan vektor saja?**
Vektor bagus menangkap parafrase, tapi lemah untuk istilah persis seperti nama segmen atau istilah akuntansi. Full-text search kebalikannya. Keduanya digabung dengan Reciprocal Rank Fusion di dalam satu fungsi SQL, jadi cukup satu round trip ke database.

**3. Bagaimana kamu mencegah halusinasi?**
Tiga lapis. Gerbang keyakinan menolak kalau cosine terbaik di bawah 0,66. System prompt melarang mengarang atau membulatkan angka dan mewajibkan sitasi. Panel bukti membuat pembaca bisa mengecek sendiri. Saya juga terus terang bahwa faithfulness jawaban belum diukur, baru retrieval.

**4. Dari mana angka 0,66?**
Dari eval. Pertanyaan valid mencetak 0,707 sampai 0,815, pertanyaan di luar cakupan 0,472 sampai 0,612. Ambang lama 0,68 hanya menyisakan margin 0,027 di atas pertanyaan valid terendah, jadi saya pindahkan ke titik tengah celah.

**5. Ceritakan bug paling menarik yang kamu perbaiki.**
Pertanyaan perbandingan NVIDIA dan Apple mengembalikan 6 chunk NVIDIA dan nol Apple, karena satu pencarian dimenangkan laporan yang kata-katanya paling mirip. Solusinya satu pencarian per perusahaan lalu diselang-seling. Yang kedua bug latensi: satu model Gemini menerima request lalu diam 45 detik lebih, jadi satu pertanyaan makan 97 detik. Saya tambahkan batas 6 detik untuk token pertama, dan pertanyaan yang sama jadi 4 detik.

**6. Kenapa ditulis ulang dari Python ke Next.js?**
Versi Python butuh server yang hidup terus, dan semua opsi gratis waktu itu menyisakan masalah kartu kredit atau batas plan. Rewrite menghilangkan masalah hosting, dengan biaya semua angka v1 tidak lagi berlaku sebagai bukti, jadi semuanya saya ukur ulang.

**7. Bagaimana menangani batasan serverless?**
Ingest yang butuh menit dipecah jadi mesin status, 12 chunk per request, dan loop-nya digerakkan browser admin. Kuota disimpan di database karena memori serverless tidak bertahan. Embedding di-cache berdasarkan hash supaya ingest ulang hampir gratis.

**8. Apa yang akan kamu kerjakan berikutnya?**
Mengukur faithfulness jawaban dengan LLM judge, memperbesar golden set, dan menulis threat model untuk prompt injection.

## 12. Kamus istilah

| Istilah | Arti sederhana |
|---|---|
| 10-K | Laporan tahunan wajib perusahaan publik AS ke SEC, isinya bisnis, risiko, dan keuangan. |
| SEC EDGAR | Situs resmi SEC tempat semua laporan perusahaan publik bisa diunduh gratis. |
| Item (10-K) | Bab baku dalam 10-K, misalnya Item 1A Risk Factors atau Item 7 MD&A. |
| RAG | Retrieval-augmented generation: cari dokumen relevan dulu, baru suruh model bahasa menjawab dari dokumen itu. |
| Chunk | Potongan teks kecil (di sini sekitar 1.200 karakter) yang jadi satuan pencarian. |
| Overlap | Bagian ujung chunk sebelumnya yang diulang di chunk berikutnya supaya fakta di perbatasan tidak terpotong. |
| Embedding | Deretan angka yang mewakili makna teks. Teks bermakna mirip punya embedding berdekatan. |
| Cosine similarity | Ukuran kemiripan dua embedding, makin dekat ke 1 makin mirip. |
| pgvector | Ekstensi Postgres untuk menyimpan dan mencari embedding. |
| HNSW | Struktur index yang membuat pencarian vektor cepat tanpa membandingkan semua baris. |
| Full-text search | Pencarian berbasis kata kunci bawaan Postgres. |
| RRF | Reciprocal Rank Fusion: cara menggabungkan dua daftar peringkat dengan menjumlahkan `1/(60 + peringkat)`. |
| BM25 | Rumus skor kata kunci klasik yang dipakai v1. v2 memakai `ts_rank_cd` milik Postgres. |
| Reranker | Model tambahan yang mengurutkan ulang hasil pencarian. Tidak dipakai di v2. |
| Gerbang keyakinan | Aturan yang menolak menjawab kalau kemiripan terbaik di bawah 0,66. |
| Golden set | Kumpulan pertanyaan uji dengan jawaban yang diharapkan, untuk mengukur kualitas. |
| Hit-rate@6 | Persentase pertanyaan yang dokumen benarnya masuk 6 hasil teratas. |
| False refusal | Sistem menolak pertanyaan yang sebenarnya bisa dijawab. |
| Faithfulness | Seberapa setia jawaban model pada dokumen sumbernya. Belum diukur di projek ini. |
| Streaming / SSE | Jawaban dikirim sedikit demi sedikit lewat Server-Sent Events, jadi teks muncul bertahap. |
| Fallback | Pindah ke model cadangan kalau model utama gagal. |
| Serverless | Kode jalan per request tanpa server yang hidup terus, ada batas waktu dan tidak ada memori antar request. |
| RLS | Row Level Security: aturan di database yang membatasi baris mana yang boleh dibaca tiap user. |
| Service role key | Kunci server Supabase yang melewati RLS. Tidak boleh sampai ke browser. |
| HMAC | Hash dengan kunci rahasia. Dipakai untuk membuat ID tamu yang tidak bisa dibalik jadi IP. |
| Migrasi | File SQL bernomor yang mengubah struktur database secara berurutan. |

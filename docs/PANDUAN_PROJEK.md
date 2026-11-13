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

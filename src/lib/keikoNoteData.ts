// お稽古ノート（茶道教室）のクラス定義と初期データ（シード）。
// もともとプロトタイプ（https://okeiko-note-saturday.netlify.app/）にあった簡略版の内容を、
// 2026-09-12にゆちゃから共有された実際のお知らせ本文（LINE等で配信した原文）をもとに
// 書き直したもの。個人名（@〜さん等）が付いた動画メモは、名前を伏せて内容だけを反映してある
// （このノートは生徒もログインすれば全クラスの記録を閲覧できるため）。
// アプリ起動時、Firestore（keikoNoteEntries）にこれらのidがまだ存在しなければ自動的に追加する。
import type { KeikoNoteClass, KeikoNoteEntry, KeikoNoteBlock } from "@/types";

export const KEIKO_NOTE_CLASSES: KeikoNoteClass[] = [
  { id: "sat-furo", main: "土曜日クラス", sub: "風炉薄茶平点前" },
  { id: "sun-nyumon", main: "日曜日クラス", sub: "入門" },
  { id: "tue-nyumon", main: "火曜日クラス", sub: "入門" },
];

const SEED_ENTRY: KeikoNoteEntry = {
  id: "seed-20260801",
  classId: "sat-furo",
  date: "2026-08-01",
  title: "お稽古振り返り",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "四海波静　先代家元 四方斎宗匠筆" },
        { label: "花入", value: "宗全籠" },
        { label: "花", value: "宗旦むくげ、赤詰草、赤水引草、アベリア" },
        { label: "茶", value: "宮の白　丸久小山園詰" },
        { label: "菓子", value: "日車　鶴屋八幡製" },
      ],
    },
    {
      type: "section",
      title: "お稽古内容",
      text:
        "午前中は前半パートの復習をしました。\n皆様大体の流れは掴めてきているように思いました。\n次回のお稽古で先生からのガイドがなくお点前出来ることを目指していけたらと思います🙇‍♀️\n\n午後は後半パートを少し行いました。拝見前の道具を片付けるところを重点的に行いました。\n次回も復習で通し稽古で復習しながら細かい所作をお伝えしていけたらと思っております。\n\n細かいところはある程度できているので、まずは通し点前の動画を見ていただき、流れをしっかり掴んでいただけたらと思います。",
    },
    {
      type: "videos",
      title: "動画",
      items: [
        {
          label: "風炉薄茶平点前（通し）",
          url: "https://x.gd/HDri9?openExternalBrowser=1",
          caption: "通しの流れを一度ご覧いただき、全体像のイメージをお持ちください。",
        },
      ],
    },
    {
      type: "videos",
      title: "参考動画（お時間があれば）",
      items: [
        {
          label: "服紗さばき",
          url: "https://x.gd/kRK9s?openExternalBrowser=1",
          caption: "ばたつかないよう、片方の手でしっかり握り込むのがコツです。",
        },
        { label: "茶巾のたたみ方", url: "https://x.gd/oFYWN?openExternalBrowser=1" },
        {
          label: "薄茶盛の扱い",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/c3a1d773-45f2-4a16-90eb-d1ac7adce977?openExternalBrowser=1",
          caption: "お茶を淹れたあと、置く位置や茶杓のあしらい方などが説明されています。",
        },
        {
          label: "服紗の扱い（腰から取る所作）",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/827dc877-d4eb-4827-be05-0b6eae12b25b",
          caption: "腰から服紗を取る扱いが説明されています。",
        },
      ],
    },
  ],
};

const SEED_ENTRY_2: KeikoNoteEntry = {
  id: "seed-20260401",
  classId: "sat-furo",
  date: "2026-04-01",
  title: "茶道教室　4月お稽古のご案内",
  teacher: "",
  blocks: [
    {
      type: "text",
      text:
        "皆様\n入門ならびに炭点前のご習得、誠におめでとうございます。\n\n今後の茶道教室に関しての手引きも下記のリンクにございますので、ご覧くださいませ。",
    },
    {
      type: "link",
      label: "今後の茶道教室に関しての手引き",
      url: "https://mypage.sohenryu.com/api/system/dbfiles/d5a4bc46364cafdfab1b83404dde2a501f83d71c3029f28240a56d0964832cc2.pdf",
    },
    {
      type: "text",
      text:
        "さて、4月からは「風炉薄茶平点前」と申しまして、実際にお茶を点てる所作の稽古に入ってまいります。\n\nこれまでは、風炉の準備から火を熾し、炭を組み、簡単にお茶を点てるところまでを学んでまいりましたが、今後はより正式なお点前へと進んでまいります。",
    },
    {
      type: "bullets",
      items: [
        "お抹茶は茶漉し缶ではなく、「薄茶盛（棗）」に入れる",
        "茶杓は水屋用ではなく、お点前用の茶杓を使用する",
        "お茶盌はタオルではなく、「茶巾」で清める",
        "鉄瓶からではなく、「柄杓」を用いて湯を汲む",
      ],
    },
    {
      type: "text",
      text:
        "このように、お客様の前でお茶を点てる正式なお点前を学びます。\n\n新しい内容が多くなりますので、最初から通しで行うのではなく、\n炭点前と同様に「割稽古」にて、一つ一つ丁寧に身につけていきましょう。",
    },
    {
      type: "tools",
      title: "新しく使用するお道具",
      items: [
        { name: "薄茶盛（棗）", desc: "お抹茶を入れるための漆の器" },
        { name: "茶杓", desc: "お抹茶をすくうための道具" },
        { name: "柄杓", desc: "湯や水を汲むための道具" },
        { name: "服紗", desc: "棗や茶杓を清めるための布" },
        { name: "茶巾", desc: "お茶盌を拭くための白い布" },
      ],
    },
    {
      type: "videos",
      title: "事前にご覧いただきたい動画",
      emphasize: true,
      items: [
        {
          label: "風炉薄茶平点前（通し）",
          url: "https://x.gd/HDri9?openExternalBrowser=1",
          caption: "通しの流れを一度ご覧いただき、全体像のイメージをお持ちください。",
        },
        {
          label: "服紗のたたみ方",
          url: "https://x.gd/veQNL?openExternalBrowser=1",
          caption:
            "入門時にお渡しした服紗を、ご自宅でたたんでいただき、服紗ばさみに入れて、扇子・懐紙とともにご持参ください。",
        },
      ],
    },
    {
      type: "bullets",
      title: "次回のお稽古内容",
      items: ["服紗さばき", "茶巾のたたみ方", "柄杓での湯の汲み方"],
    },
    {
      type: "videoGroup",
      title: "参考動画",
      groups: [
        {
          title: "服紗の付け方",
          note: "※男女で異なります",
          variants: [
            { label: "男性", url: "https://x.gd/6lEioh?openExternalBrowser=1" },
            { label: "女性", url: "https://x.gd/xPyTQ?openExternalBrowser=1" },
          ],
        },
        {
          title: "服紗さばき",
          variants: [
            { label: "男性", url: "https://x.gd/oZHjz?openExternalBrowser=1" },
            { label: "女性", url: "https://x.gd/kRK9s?openExternalBrowser=1" },
          ],
        },
        {
          title: "茶巾のたたみ方",
          variants: [{ label: "動画を見る", url: "https://x.gd/oFYWN?openExternalBrowser=1" }],
        },
        {
          title: "茶盌への仕込み",
          variants: [{ label: "動画を見る", url: "https://x.gd/DoSxd?openExternalBrowser=1" }],
        },
        {
          title: "湯の汲み方",
          variants: [{ label: "動画を見る", url: "https://x.gd/QtvqK?openExternalBrowser=1" }],
        },
      ],
    },
  ],
};

const KAKEJIKU_GROUP: KeikoNoteBlock = {
  type: "videoGroup",
  title: "掛軸の扱い",
  groups: [
    {
      variants: [
        {
          label: "掛軸の掛け方",
          url: "https://one-stream.io/user/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/d9e5ea6d-9139-4587-bb69-d92272a1fb52?openExternalBrowser=1",
        },
        {
          label: "掛軸の外し方と片付け方",
          url: "https://one-stream.io/user/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/58c5200e-ddbd-445b-a641-db0f8285a95b?openExternalBrowser=1",
        },
      ],
    },
  ],
};

const KEIKOGO_VIDEOGROUP: KeikoNoteBlock = {
  type: "videoGroup",
  title: "割稽古",
  groups: [
    {
      title: "服紗の扱い",
      variants: [
        { label: "服紗の付け方（男性）", url: "https://x.gd/6lEioh?openExternalBrowser=1" },
        { label: "服紗さばき（男性）", url: "https://x.gd/oZHjz?openExternalBrowser=1" },
        { label: "薄茶盛の浄め方（持ち方・蓋の開閉含む）", url: "https://x.gd/ERcjD?openExternalBrowser=1" },
        { label: "茶杓の浄め方", url: "https://x.gd/mtiBh?openExternalBrowser=1" },
        { label: "たたみ直し", url: "https://x.gd/sZsnS?openExternalBrowser=1" },
      ],
    },
    {
      title: "茶巾の扱い",
      variants: [
        { label: "ふくだめ", url: "https://x.gd/DoSxd?openExternalBrowser=1" },
        { label: "茶盌の拭き方", url: "https://x.gd/7zJi0?openExternalBrowser=1" },
        { label: "茶巾のたたみ直し", url: "https://x.gd/vQPkL?openExternalBrowser=1" },
      ],
    },
    {
      title: "その他",
      variants: [{ label: "茶盌への仕込み（茶巾・茶筅・茶杓）", url: "https://x.gd/DoSxd?openExternalBrowser=1" }],
    },
    {
      title: "柄杓の扱い",
      variants: [
        {
          label: "柄杓の持ち方（構え方・持ち方・手の添え方・合の動かし方含む）",
          url: "https://x.gd/hVVgw?openExternalBrowser=1",
        },
        { label: "湯の汲み方", url: "https://x.gd/QtvqK?openExternalBrowser=1" },
        { label: "置き柄杓", url: "https://x.gd/Y3Qeg?openExternalBrowser=1" },
        { label: "取り柄杓", url: "https://x.gd/Ls9iD?openExternalBrowser=1" },
        { label: "引き柄杓", url: "https://x.gd/ggt9g?openExternalBrowser=1" },
      ],
    },
  ],
};

const KEIKOGO_ZENHAN_BULLETS: string[] = [
  "点前座にて置き合わせ",
  "薄茶盛・茶杓の清め",
  "湯を汲む",
  "茶盌を温める",
  "抹茶を入れる",
  "お茶を点てる",
];

const SEED_ENTRY_3: KeikoNoteEntry = {
  id: "seed-20260404",
  classId: "sat-furo",
  date: "2026-04-04",
  title: "お稽古の振り返り",
  teacher: "",
  blocks: [
    { type: "section", title: "目的", text: "点前の全体像の理解および基礎の習得" },
    {
      type: "bullets",
      title: "内容",
      items: [
        "通し点前動画による流れの確認（ご自宅での予習）",
        "新しく登場した道具の名称（服紗／茶巾／薄茶盛／茶杓／柄杓／建水／蓋置）",
      ],
    },
    KEIKOGO_VIDEOGROUP,
    { type: "link", label: "点前（簡略）", url: "https://x.gd/eLD4n?openExternalBrowser=1" },
    { type: "text", text: "※持ち出しなし" },
    { type: "bullets", items: KEIKOGO_ZENHAN_BULLETS },
    { type: "text", text: "👉 本日は流れの理解を優先して行いました" },
  ],
};

const SEED_ENTRY_4: KeikoNoteEntry = {
  id: "seed-20260425",
  classId: "sat-furo",
  date: "2026-04-25",
  title: "お稽古の振り返り",
  teacher: "",
  blocks: [
    { type: "section", title: "目的", text: "点前の全体像の理解および基礎の習得" },
    {
      type: "bullets",
      title: "内容",
      items: [
        "通し点前動画による流れの確認（ご自宅での予習）",
        "新しく登場した道具の名称（服紗／茶巾／薄茶盛／茶杓／柄杓／建水／蓋置）",
      ],
    },
    {
      type: "videoGroup",
      title: "割稽古",
      groups: [
        {
          title: "服紗の扱い",
          variants: [
            { label: "服紗の付け方（男性）", url: "https://x.gd/6lEioh?openExternalBrowser=1" },
            { label: "服紗さばき（男性）", url: "https://x.gd/oZHjz?openExternalBrowser=1" },
            { label: "薄茶盛の浄め方（持ち方・蓋の開閉含む）", url: "https://x.gd/ERcjD?openExternalBrowser=1" },
            { label: "茶杓の浄め方", url: "https://x.gd/mtiBh?openExternalBrowser=1" },
            { label: "たたみ直し", url: "https://x.gd/sZsnS?openExternalBrowser=1" },
          ],
        },
        {
          title: "茶巾の扱い",
          variants: [
            { label: "ふくだめ", url: "https://x.gd/DoSxd?openExternalBrowser=1" },
            { label: "茶盌の拭き方", url: "https://x.gd/7zJi0?openExternalBrowser=1" },
            { label: "茶巾のたたみ直し", url: "https://x.gd/vQPkL?openExternalBrowser=1" },
          ],
        },
        {
          title: "その他",
          variants: [{ label: "茶盌への仕込み（茶巾・茶筅・茶杓）", url: "https://x.gd/DoSxd?openExternalBrowser=1" }],
        },
        {
          title: "柄杓の扱い",
          variants: [
            {
              label: "柄杓の持ち方（構え方・持ち方・手の添え方・合の動かし方含む）",
              url: "https://x.gd/hVVgw?openExternalBrowser=1",
            },
            { label: "湯の汲み方", url: "https://x.gd/QtvqK?openExternalBrowser=1" },
            { label: "置き柄杓", url: "https://x.gd/Y3Qeg?openExternalBrowser=1" },
            { label: "取り柄杓", url: "https://x.gd/Ls9iD?openExternalBrowser=1" },
          ],
        },
      ],
    },
    { type: "link", label: "点前（簡略）", url: "https://x.gd/eLD4n?openExternalBrowser=1" },
    { type: "text", text: "※持ち出しなし" },
    { type: "bullets", items: KEIKOGO_ZENHAN_BULLETS },
    { type: "text", text: "👉 本日は流れの理解を優先して行いました" },
    { type: "text", text: "準備や片付けも引き続き学んでまいります。\n掛軸の扱いも動画がございますのでご覧くださいませ。" },
    KAKEJIKU_GROUP,
  ],
};

const SEED_ENTRY_5: KeikoNoteEntry = {
  id: "seed-2026-05",
  classId: "sat-furo",
  date: "2026-05-01",
  title: "5月のお稽古の振り返り",
  teacher: "",
  blocks: [
    { type: "section", title: "目的", text: "お茶が出て、問答までの前半パートの流れなど基礎の習得" },
    { type: "bullets", title: "内容", items: ["柄杓の扱い", "両器、柄杓、蓋置、建水の持ち出し"] },
    {
      type: "videoGroup",
      title: "割稽古",
      groups: [
        {
          variants: [
            {
              label: "両器持ち出し",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e616b721-cf32-4778-847e-4543aa6a1b42?openExternalBrowser=1",
            },
            {
              label: "両器の置き位置",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e9edbe87-5e83-498c-be3f-bf33c0f2c093",
            },
            {
              label: "蓋置、柄杓、建水の持ち方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/fb2b7503-3078-4a34-a67b-77ce31339840?openExternalBrowser=1",
            },
            {
              label: "柄杓、蓋置、建水の持ち出しと定座に置く（柄杓の抜き方、蓋置への置き方含む）",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/f886f035-5ee1-4bd6-b3bc-313ebf3aa984?openExternalBrowser=1",
            },
            {
              label: "釜の蓋の開け方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/cf451370-bb38-4111-9a2b-42fab325136d?openExternalBrowser=1",
            },
            {
              label: "引き柄杓",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/5e0438a4-9a5d-484f-aca2-ef24be10493d?openExternalBrowser=1",
            },
            {
              label: "つけ込み柄杓",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/a47ae7be-a1b6-4abf-bed3-c91be1ed1c20?openExternalBrowser=1",
            },
          ],
        },
      ],
    },
    { type: "text", text: "※点前の最初、釜の蓋を開けて、初めて柄杓を釜の上に置くときだけ「置き柄杓」それ以降は引き柄杓です" },
    { type: "link", label: "点前（前半パート）", url: "https://x.gd/eLD4n?openExternalBrowser=1" },
    { type: "text", text: "※水壺の蓋浄める、茶筅通し、水壺の蓋開けるなし" },
    { type: "bullets", items: [...KEIKOGO_ZENHAN_BULLETS, "問答"] },
    { type: "text", text: "👉 本日は流れの理解を優先して行いました" },
    {
      type: "section",
      title: "片付け",
      text: "準備や片付けも引き続き学んでまいります。\n掛軸の扱いも動画がございますのでご覧くださいませ。",
    },
    KAKEJIKU_GROUP,
    { type: "text", text: "お茶を点てて、問答までの前半パート完結編です。" },
    { type: "bullets", title: "6月のお稽古内容", items: ["水壺の蓋浄める", "茶筅通し", "水壺の蓋開ける"] },
  ],
};

const SEED_ENTRY_6: KeikoNoteEntry = {
  id: "seed-2026-06",
  classId: "sat-furo",
  date: "2026-06-01",
  title: "6月のお稽古の振り返り",
  teacher: "",
  blocks: [
    { type: "section", title: "目的", text: "お茶を出し、問答までの前半パートの流れを習得" },
    { type: "bullets", title: "内容（復習）", items: ["服紗さばき", "茶巾のたたみ方", "柄杓の扱い", "両器、柄杓、蓋置、建水の持ち出し"] },
    { type: "bullets", title: "内容（新しいこと）", items: ["水壺の蓋浄める", "茶筅通し", "水壺の蓋開ける"] },
    {
      type: "videoGroup",
      title: "割稽古",
      groups: [
        {
          variants: [
            {
              label: "両器持ち出し",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e616b721-cf32-4778-847e-4543aa6a1b42?openExternalBrowser=1",
            },
            {
              label: "両器の置き位置",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e9edbe87-5e83-498c-be3f-bf33c0f2c093",
            },
            {
              label: "蓋置、柄杓、建水の持ち方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/fb2b7503-3078-4a34-a67b-77ce31339840?openExternalBrowser=1",
            },
            {
              label: "柄杓、蓋置、建水の持ち出しと定座に置く（柄杓の抜き方、蓋置への置き方含む）",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/f886f035-5ee1-4bd6-b3bc-313ebf3aa984?openExternalBrowser=1",
            },
            {
              label: "薄茶盛の浄め方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e7b491ae-e0bf-4419-8801-8763a9e65186?openExternalBrowser=1",
            },
            {
              label: "茶杓の浄め方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e61535fb-f23c-477e-802c-f62c2dfd081f?openExternalBrowser=1",
            },
            {
              label: "釜の蓋の開け方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/cf451370-bb38-4111-9a2b-42fab325136d?openExternalBrowser=1",
            },
            {
              label: "🆕 水壺の蓋の浄め方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/8b48f817-2248-4e60-abd7-7a88f91bfb8e?openExternalBrowser=1",
            },
            {
              label: "🆕 茶筅通し",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/61d6a3f7-2a63-4376-9103-23de4bc24d5a?openExternalBrowser=1",
            },
            {
              label: "🆕 水壺の蓋の開け方",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/a778f115-1d24-429c-b7b8-ed83cd65538f?openExternalBrowser=1",
            },
            {
              label: "置き柄杓",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/d3475d4c-45d0-44aa-9335-09bef1119277?openExternalBrowser=1",
            },
            {
              label: "引き柄杓",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/5e0438a4-9a5d-484f-aca2-ef24be10493d?openExternalBrowser=1",
            },
            {
              label: "つけ込み柄杓",
              url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/a47ae7be-a1b6-4abf-bed3-c91be1ed1c20?openExternalBrowser=1",
            },
          ],
        },
      ],
    },
    { type: "text", text: "※点前の最初、釜の蓋を開けて、初めて柄杓を釜の上に置くときだけ「置き柄杓」それ以降は引き柄杓です" },
    { type: "link", label: "点前（前半パート）", url: "https://x.gd/eLD4n?openExternalBrowser=1" },
    { type: "bullets", items: [...KEIKOGO_ZENHAN_BULLETS, "問答"] },
    {
      type: "section",
      title: "準備と片付け",
      text: "準備や片付けも引き続き学んでまいります。\n掛軸の扱いも動画がございますのでご覧くださいませ。",
    },
    KAKEJIKU_GROUP,
    { type: "text", text: "お茶を点てて、問答までの前半パートを繰り返し行い、完成させていきます" },
  ],
};

const SEED_ENTRY_7: KeikoNoteEntry = {
  id: "seed-20260711",
  classId: "sat-furo",
  date: "2026-07-11",
  title: "お稽古振り返り",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "「朝顔」　川喜田半泥子筆" },
        { label: "花入", value: "桂川籠" },
        { label: "花", value: "なし" },
        { label: "茶盌", value: "絵高麗　永楽作" },
        { label: "茶", value: "宮の白　丸久小山園詰" },
        { label: "菓子", value: "成瓢　鶴屋八幡製" },
      ],
    },
    { type: "link", label: "川喜田半泥子について", url: "https://ja.wikipedia.org/wiki/%E5%B7%9D%E5%96%9C%E7%94%B0%E5%8D%8A%E6%B3%A5%E5%AD%90" },
    { type: "section", title: "目的", text: "お茶を出し、問答までの前半パートの流れを習得" },
    { type: "bullets", title: "内容", items: ["床の拝見の復習", "点前座歩き方の復習"] },
    {
      type: "videos",
      title: "おすすめ割稽古",
      items: [
        { label: "すり足", url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/8e02f155-1a08-4b3b-b492-7ca36cc2936e" },
        { label: "両器の置き位置", url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e9edbe87-5e83-498c-be3f-bf33c0f2c093" },
        { label: "茶杓の浄め方", url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e61535fb-f23c-477e-802c-f62c2dfd081f" },
        {
          label: "点前時の薄茶盛の開け方",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/c3a1d773-45f2-4a16-90eb-d1ac7adce977",
        },
        { label: "釜の蓋の開け方", url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/cf451370-bb38-4111-9a2b-42fab325136d" },
        {
          label: "柄杓の持ちぐるみに関して",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/fb2b7503-3078-4a34-a67b-77ce31339840",
        },
        { label: "薄茶盛の浄め方", url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e7b491ae-e0bf-4419-8801-8763a9e65186" },
      ],
    },
    { type: "link", label: "通し点前（前半パート）", url: "https://x.gd/eLD4n?openExternalBrowser=1" },
    { type: "bullets", items: [...KEIKOGO_ZENHAN_BULLETS, "問答"] },
  ],
};

const SEED_ENTRY_8: KeikoNoteEntry = {
  id: "seed-20260718",
  classId: "sat-furo",
  date: "2026-07-18",
  title: "お稽古振り返り",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "土佐光貞筆「乞巧奠（きっこうでん）」" },
        { label: "花入", value: "宗全籠" },
        { label: "花", value: "キヌガサギク、紫式部、矢羽ススキ、芙蓉、折鶴蘭" },
        { label: "茶", value: "宮の白　丸久小山園詰" },
        { label: "菓子", value: "待宵草　鶴屋八幡製" },
      ],
    },
    { type: "link", label: "土佐光貞について", url: "https://kakejikuya-nagoya.jp/artist/tosa-mitsusada.html" },
    { type: "link", label: "乞巧奠について", url: "https://www.kyototuu.jp/Sightseeing/MatsuriKikkouden.html" },
    { type: "section", title: "お稽古内容", text: "8月から後半パートに進ため、前半パートを完成" },
    { type: "link", label: "動画：通し点前（前半パート）", url: "https://x.gd/eLD4n?openExternalBrowser=1" },
    { type: "bullets", items: [...KEIKOGO_ZENHAN_BULLETS, "問答"] },
    {
      type: "text",
      text:
        "お菓子をどうぞとお茶を入れた後は、茶杓の櫂先が上に向かないように意識してみてください。\n\n茶杓を浄めた後は、茶筅を茶盌から出し、茶盌を引いてから水壺の蓋を浄める、という順番を意識してみてください。",
    },
    {
      type: "videos",
      title: "おすすめ割稽古",
      items: [
        {
          label: "水壺の蓋の浄め方",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/8b48f817-2248-4e60-abd7-7a88f91bfb8e",
          caption: "服紗の折り方も確認してみてください。",
        },
        {
          label: "湯の汲み方・入れ方",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/df775491-12da-4516-9670-7c0743b618d6",
          caption: "お茶盌を温める際にお湯を入れるときの手首の動かし方を復習してみてください。",
        },
        {
          label: "柄杓、蓋置、建水の持ち出しと定座に置く",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/f886f035-5ee1-4bd6-b3bc-313ebf3aa984",
          caption: "最初に柄杓を蓋置に置くときの手の動きを確認してみてください。",
        },
        {
          label: "両器持ち出し",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/e616b721-cf32-4778-847e-4543aa6a1b42",
        },
      ],
    },
  ],
};

const SEED_ENTRY_8B: KeikoNoteEntry = {
  id: "seed-20260725",
  classId: "sat-furo",
  date: "2026-07-25",
  title: "お稽古振り返り",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "土佐光貞筆「乞巧奠（きっこうでん）」" },
        { label: "花入", value: "宗全籠" },
        { label: "茶", value: "宮の白　丸久小山園詰" },
        { label: "菓子", value: "松露　亀屋良永製" },
      ],
    },
    { type: "link", label: "土佐光貞について", url: "https://kakejikuya-nagoya.jp/artist/tosa-mitsusada.html" },
    { type: "link", label: "乞巧奠について", url: "https://www.kyototuu.jp/Sightseeing/MatsuriKikkouden.html" },
    {
      type: "section",
      title: "お稽古内容",
      text:
        "これまでは、風炉の準備から火を熾し、炭を組み、簡単にお茶を点てるところまでを学んでまいりましたが、今後はより正式なお点前へと進んでまいります。\n\n本日から開始したお点前は「風炉薄茶平点前」と申しまして、実際にお茶を点てる所作の稽古に入ってまいります。",
    },
    {
      type: "bullets",
      items: [
        "お抹茶は茶漉し缶ではなく、「薄茶盛（棗）」に入れる",
        "茶杓は水屋用ではなく、お点前用の茶杓を使用する",
        "お茶盌はタオルではなく、「茶巾」で清める",
        "鉄瓶からではなく、「柄杓」を用いて湯を汲む",
      ],
    },
    {
      type: "text",
      text:
        "このように、お客様の前でお茶を点てる正式なお点前を学びます。\n\n新しい内容が多くなりますので、最初から通しで行うのではなく、炭点前と同様に「割稽古」にて、説明させていただきました。\n\n下記復習内容になっておりますので、次回のお稽古までにご確認いただけたら嬉しいです。",
    },
    {
      type: "tools",
      title: "新しく使用するお道具",
      items: [
        { name: "薄茶盛（棗）", desc: "お抹茶を入れるための漆の器" },
        { name: "茶杓", desc: "お抹茶をすくうための道具" },
        { name: "柄杓", desc: "湯や水を汲むための道具" },
        { name: "服紗", desc: "棗や茶杓を清めるための布" },
        { name: "茶巾", desc: "お茶盌を拭くための白い布" },
      ],
    },
    {
      type: "videos",
      title: "参考動画",
      items: [
        {
          label: "風炉薄茶平点前（通し）",
          url: "https://x.gd/HDri9?openExternalBrowser=1",
          caption: "通しの流れを一度ご覧いただき、全体像のイメージをお持ちください。",
        },
      ],
    },
    {
      type: "videoGroup",
      title: "参考動画（割稽古）",
      groups: [
        { title: "服紗の付け方", variants: [{ label: "女性", url: "https://x.gd/xPyTQ?openExternalBrowser=1" }] },
        { title: "服紗さばき", variants: [{ label: "女性", url: "https://x.gd/kRK9s?openExternalBrowser=1" }] },
        { title: "茶巾のたたみ方", variants: [{ label: "動画を見る", url: "https://x.gd/oFYWN?openExternalBrowser=1" }] },
        { title: "茶盌への仕込み", variants: [{ label: "動画を見る", url: "https://x.gd/DoSxd?openExternalBrowser=1" }] },
        { title: "湯の汲み方", variants: [{ label: "動画を見る", url: "https://x.gd/QtvqK?openExternalBrowser=1" }] },
        {
          title: "柄杓の持ち方",
          note: "（構え方・持ち方・手の添え方・合の動かし方含む）",
          variants: [{ label: "動画を見る", url: "https://x.gd/hVVgw?openExternalBrowser=1" }],
        },
        { title: "置き柄杓", variants: [{ label: "動画を見る", url: "https://x.gd/Y3Qeg?openExternalBrowser=1" }] },
        { title: "取り柄杓", variants: [{ label: "動画を見る", url: "https://x.gd/Ls9iD?openExternalBrowser=1" }] },
      ],
    },
  ],
};

const SEED_ENTRY_9: KeikoNoteEntry = {
  id: "seed-20260822",
  classId: "sat-furo",
  date: "2026-08-22",
  title: "お稽古振り返り",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "土佐光貞筆「乞巧奠（きっこうでん）」" },
        { label: "花入", value: "耳付き籠" },
        { label: "花", value: "むくげ、水引" },
        { label: "菓子器", value: "根来（ねごろ）　村瀬治兵衛造" },
        { label: "茶", value: "幸の白　上林春松本店詰" },
        { label: "菓子", value: "花火　鶴屋八幡製" },
      ],
    },
    {
      type: "link",
      label: "写真",
      url: "https://www.dropbox.com/scl/fo/2si1w7jffrjz5qguo94xv/AFtSFI_Rwq3-Br_NlkiK4BY?rlkey=iofn0ojkycxg2ioodc3qp3isj&st=9cbuqcny&dl=0",
    },
    {
      type: "link",
      label: "動画",
      url: "https://www.dropbox.com/scl/fo/m0drmimyyya6qkm655mlo/AAoEMbP1dqg2o7WSXl182I0?rlkey=x4fir30vjfogbcpeog1u2l1gh&st=90zr266h&dl=0",
    },
    { type: "section", title: "お稽古内容", text: "午前中" },
    {
      type: "bullets",
      title: "準備",
      items: [
        "加藤さん：床の間に軸と花を掛ける／真の灰形／風炉の中に炭を組む／火起こし／風炉に下火を入れる",
        "中村さん：リネン準備／水屋瓶に水を張る／茶巾たらいに茶巾・柄杓・茶筅を浸す／湯沸かし／茶を濾して薄茶盛に入れる",
      ],
    },
    {
      type: "text",
      text:
        "後半パート①：問答の後、茶筅すすぎ、茶杓浄める、建水を下げる、水壺から釜に水を入れて、釜の蓋、水壺の蓋をするまでを勉強しました。「柄杓と蓋置の持ちぐるみ」お二人ともに苦戦されていたようでしたので、動画を見てご確認いただけたらと思います。\n\n次回は拝見盆の割稽古をしていきたいと思います。",
    },
    {
      type: "videos",
      title: "おすすめ動画",
      items: [
        {
          label: "柄杓と蓋置の持ちぐるみ",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/fb2b7503-3078-4a34-a67b-77ce31339840",
          caption: "0:40あたりからご覧ください",
        },
        {
          label: "風炉薄茶平点前（通し）",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/44c1331c-b439-475b-aeea-00dc1716cf99",
          caption: "20:15 水壺に水を指した後の柄杓の扱い",
        },
      ],
    },
    {
      type: "text",
      text:
        "午後\n\n先生の助言なしでも前半パートを行えるようにということで今回はゆっくり丁寧に前半パートの復習を行いました。\n\n次回から後半パート1をお勉強していきたいと思いますので、通し点前の動画をご覧いただきお茶を点てて問答までをもう一度復習してみてください。",
    },
    {
      type: "videos",
      title: "おすすめ動画",
      items: [
        {
          label: "後半のおすすめ動画：風炉薄茶平点前（通し）",
          url: "https://one-stream.io/catalog/WAFrlVXGvJeKz3PaYEwjUe1JjZJ3/video/44c1331c-b439-475b-aeea-00dc1716cf99",
        },
      ],
    },
    {
      type: "bullets",
      title: "お片付け",
      items: [
        "墨屋さん：火・釜を片付ける／水屋瓶・茶巾たらいの中のものを片付ける",
        "石原さん：薄茶盛を浄め、点前道具を片付ける／床の間の軸と花を片付ける",
      ],
    },
  ],
};

const SEED_ENTRY_10: KeikoNoteEntry = {
  id: "seed-20260830-sun",
  classId: "sun-nyumon",
  date: "2026-08-30",
  title: "",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "エレズとウーの鴎" },
        { label: "花入れ", value: "四方斎作　竹二重切" },
        { label: "花", value: "秋明菊" },
        { label: "水壺", value: "須田菁華　竹" },
        { label: "菓子器", value: "志野焼四方" },
        { label: "茶碗", value: "萩焼と幽々斎作唐津" },
        { label: "薄茶盛", value: "天下一" },
        { label: "蓋置", value: "竹" },
        { label: "茶", value: "鳴滝の白　山政小山園詰" },
        { label: "菓子", value: "納涼　鶴屋八幡製" },
      ],
    },
    {
      type: "section",
      title: "お稽古内容",
      text:
        "川名さん：水屋準備（湯沸かし・火起こし・風炉に下火を入れる・炭点前準備・花入に花を生ける）、Wabiyoga、炭点前、片付け（点前道具を片付ける・火を片付ける）\n\n→毎回綺麗なお花をご持参くださり生けてくださいます。今回は暫くぶりのお稽古でしたが水屋での準備は上手にされていました。帛紗の捌き方と炭点前の動画を観てきて頂けると良いかと思いました。",
    },
    {
      type: "text",
      text:
        "吉井さん：Wabiyoga、空間学習、立ち座り・歩き方稽古、炭点前・薄茶平点前お客、炭の名称を覚える・炭組み、片付け（お茶碗を洗う）\n\n→家元教授お稽古は初めてでした。熱心にお話を聞かれていて吸収しようとする意欲を感じました。炭の名称と炭組みはすんなり習得されていました。",
    },
  ],
};

const SEED_ENTRY_11: KeikoNoteEntry = {
  id: "seed-20260912",
  classId: "sat-furo",
  date: "2026-09-12",
  title: "",
  teacher: "",
  blocks: [
    {
      type: "toriawase",
      items: [
        { label: "床", value: "不審庵　希斎宗匠筆" },
        { label: "花入", value: "一重伐" },
        { label: "花", value: "秋海棠、白菊、藪蘭の葉" },
        { label: "菓子器", value: "根来" },
        { label: "茶", value: "幸の白　上林春松本店製" },
        { label: "菓子", value: "御好利木饅　虎屋製" },
      ],
    },
    { type: "section", title: "お稽古の内容", text: "風炉薄茶平点前" },
    {
      type: "section",
      title: "講師より",
      text:
        "本日のお菓子の説明\n菓銘は、「無し（梨）」の発音を避け、「梨」の字を利と木に分割して「りぼく（利木）」と読ませたことに由来しています。",
    },
    { type: "text", text: "【午前の部】10:00-12:00　墨屋さん・中村さん" },
    {
      type: "bullets",
      title: "準備（稽古時間外）",
      items: [
        "中村さん：床の間に軸と花を掛ける／真の灰形／風炉の中に炭を組む／火起こし／風炉に下火を入れる　→ 灰形を作る場合は、稽古開始の1時間前に集合",
        "墨屋さん：リネン準備／水屋瓶に水を張る／茶巾たらいに茶巾・柄杓・茶筅を浸す／湯沸かし／茶を濾して薄茶盛に入れる",
      ],
    },
    {
      type: "text",
      text:
        "後半パート①：問答の後、茶筅すすぎ、茶杓浄める、建水を下げる、水壺から釜に水を入れて、釜の蓋、水壺の蓋をするまでを復習しました。\n\nここまでのお点前を不安なくできるように次回も復習をしていけたらと思います。",
    },
  ],
};

export const KEIKO_NOTE_SEEDS: KeikoNoteEntry[] = [
  SEED_ENTRY,
  SEED_ENTRY_2,
  SEED_ENTRY_3,
  SEED_ENTRY_4,
  SEED_ENTRY_5,
  SEED_ENTRY_6,
  SEED_ENTRY_7,
  SEED_ENTRY_8,
  SEED_ENTRY_8B,
  SEED_ENTRY_9,
  SEED_ENTRY_10,
  SEED_ENTRY_11,
];

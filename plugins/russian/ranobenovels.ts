import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

// ======================================================================
// Plugin ID : ranobenovels
// Site      : https://ranobe-novels.ru (WordPress, власна тема ranobe-novels)
// Модель    : новела = рубрика (category), розділ = запис (post)
//
// Звідки що береться:
//   каталог і пошук  - WP REST API: /wp-json/wp/v2/categories
//   список розділів  - той самий запит, яким сайт заповнює меню «Все главы»:
//                      POST .../template-parts/post/menu-query.php (cat_id, offset)
//   текст розділу    - сторінка розділу, блок #js-full-content
//   обкладинка, опис - JSON-LD (schema:Book) зі сторінки новели або розділу
//
// Перевірено на живому сайті: categories?slug= (відповідь API) і розмітка
// сторінки розділу (23.11.2026). Формат відповіді menu-query.php узято
// зі скрипта сторінки; у застосунку ще не перевірено.
// ======================================================================

const SITE = 'https://ranobe-novels.ru';
const API = SITE + '/wp-json/wp/v2/';
const MENU_URL =
  SITE + '/wp-content/themes/ranobe-novels/template-parts/post/menu-query.php';

const NOVELS_PER_PAGE = 20;
const MENU_STEP = 100; // сайт віддає меню розділів порціями по 100
const PARALLEL_REQUESTS = 3; // скільки порцій тягнемо одночасно
const MAX_CHAPTERS = 30000; // запобіжник
// Рубрики, які не є новелами (сайт сам ховає їх у списку новел)
const NOT_NOVELS = ['news', 'blog', 'top-ranobe-i-novell-na-russkom'];

type WPCategory = {
  id: number;
  name: string;
  slug: string;
  link: string;
  count?: number;
};

type MenuItem = { post_name?: string; post_date?: string };

type BookMeta = {
  name?: string;
  cover?: string;
  author?: string;
  genres?: string;
  summary?: string;
};

/** HTML або рядок із &сутностями; -> звичайний текст */
function toText(html?: string): string {
  if (!html) return '';
  return loadCheerio(html).root().text().trim();
}

/** 'https://ranobe-novels.ru/ranobe/slug/' -> '/ranobe/slug/' */
function toPath(link: string): string {
  return link.replace(/^https?:\/\/[^/]+/, '');
}

async function getJson<T>(endpoint: string): Promise<T> {
  const res = await fetchApi(API + endpoint);
  if (!res.ok) {
    throw new Error(`ranobe-novels.ru: HTTP ${res.status} (${endpoint})`);
  }
  return (await res.json()) as T;
}

/** Рядкове поле з JSON-LD. Регулярка, бо JSON на сайті не завжди валідний. */
function ldField(ld: string, key: string): string | undefined {
  const m = ld.match(
    new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'),
  );
  if (!m) return undefined;
  let value = m[1];
  try {
    value = String(JSON.parse('"' + m[1] + '"'));
  } catch (e) {
    // лишаємо як є
  }
  return value.trim() || undefined;
}

/** Дані книги з блоку <script type="application/ld+json"> (вузол schema:Book) */
function readBookMeta(html: string): BookMeta {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let ld = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!ld || m[1].indexOf('schema:Book') !== -1) ld = m[1];
  }
  if (!ld) return {};
  return {
    name: ldField(ld, 'schema:name'),
    cover: ldField(ld, '@image'),
    author: ldField(ld, 'schema:author'),
    genres: ldField(ld, 'genre'),
    summary: ldField(ld, 'description'),
  };
}

/** Жанри як окремі мітки: посилання виду /novels/<мітка>/ в основній частині */
function readGenreLinks(html: string): string[] {
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  if (!main) return [];
  const re =
    /<a\b[^>]*href=["'][^"']*\/novels\/[^"']*["'][^>]*>([^<]+)<\/a>/gi;
  const genres: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(main[0]))) {
    const genre = toText(m[1]);
    if (genre && genres.indexOf(genre) === -1) genres.push(genre);
  }
  return genres;
}

/** Одна порція меню розділів, як її запитує сама сторінка сайту */
async function fetchMenu(
  catId: number,
  offset: number,
  referer: string,
): Promise<MenuItem[]> {
  const res = await fetchApi(MENU_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': SITE,
      'Referer': referer,
    },
    body: `cat_id=${catId}&offset=${offset}`,
  });
  if (!res.ok) {
    throw new Error(`ranobe-novels.ru: список розділів, HTTP ${res.status}`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      'ranobe-novels.ru: сайт повернув список розділів у невідомому форматі',
    );
  }
  return Array.isArray(data) ? (data as MenuItem[]) : [];
}

class RanobeNovelsPlugin implements Plugin.PluginBase {
  id = 'ranobenovels';
  name = 'Ranobe-Novels';
  icon = 'src/ru/ranobenovels/icon.png';
  site = SITE;
  version = '1.0.0';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: { Referer: SITE + '/' },
  };

  private async listNovels(
    query: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    try {
      const cats = await getJson<WPCategory[]>(
        `categories?${query}&hide_empty=true&per_page=${NOVELS_PER_PAGE}&page=${pageNo}&_fields=id,name,slug,link`,
      );
      return cats
        .filter(c => NOT_NOVELS.indexOf(c.slug) === -1)
        .map(c => ({
          name: toText(c.name),
          path: toPath(c.link),
          cover: defaultCover, // у списку рубрик API обкладинок немає
        }));
    } catch (e) {
      if (pageNo > 1) return []; // сторінки закінчились
      throw e;
    }
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    // «Популярне» = найбільше розділів; «Останні» = нещодавно додані новели
    return this.listNovels(
      showLatestNovels ? 'orderby=id&order=desc' : 'orderby=count&order=desc',
      pageNo,
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    return this.listNovels('search=' + encodeURIComponent(searchTerm), pageNo);
  }

  private async loadChapters(
    catId: number,
    count: number,
    referer: string,
  ): Promise<Plugin.ChapterItem[]> {
    const chapters: Plugin.ChapterItem[] = [];
    const seen: Record<string, boolean> = {};
    const limit = count > 0 ? Math.min(count, MAX_CHAPTERS) : MAX_CHAPTERS;
    // Якщо кількість розділів невідома, йдемо по одній порції до порожньої
    const parallel = count > 0 ? PARALLEL_REQUESTS : 1;

    let offset = 0;
    let done = false;
    while (!done && offset < limit) {
      const offsets: number[] = [];
      for (let i = 0; i < parallel; i++) {
        const o = offset + i * MENU_STEP;
        if (o < limit) offsets.push(o);
      }
      offset += offsets.length * MENU_STEP;

      const batches = await Promise.all(
        offsets.map(o => fetchMenu(catId, o, referer)),
      );
      for (let b = 0; b < batches.length; b++) {
        if (!batches[b].length) {
          done = true; // порожня порція = розділи закінчились
          break;
        }
        for (let i = 0; i < batches[b].length; i++) {
          const item = batches[b][i];
          if (!item || !item.post_name || seen[item.post_name]) continue;
          seen[item.post_name] = true;
          // Як і в меню сайту, номер розділу = його позиція у списку.
          // Номери в адресах і заголовках записів на сайті бувають зсунуті
          // відносно тексту, тому на них не спираємось.
          const n = chapters.length + 1;
          chapters.push({
            name: `Глава ${n}`,
            path: `/${item.post_name}/`,
            chapterNumber: n,
            releaseTime: item.post_date,
          });
        }
      }
    }
    return chapters;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath.split('?')[0].split('/').filter(Boolean).pop();
    if (!slug) throw new Error(`Некоректний шлях новели: ${novelPath}`);
    const novelUrl = SITE + novelPath;

    // 1. Сторінка новели: метадані (і запасне джерело id рубрики)
    let pageHtml = '';
    try {
      const res = await fetchApi(novelUrl);
      if (res.ok) pageHtml = await res.text();
    } catch (e) {
      // не критично
    }

    // 2. Рубрика: id потрібен для списку розділів, count — щоб знати, скільки їх
    let catId = 0;
    let count = 0;
    let name = '';
    try {
      const cats = await getJson<WPCategory[]>(
        `categories?slug=${slug}&_fields=id,name,slug,link,count`,
      );
      if (cats[0]) {
        catId = cats[0].id;
        count = cats[0].count || 0;
        name = toText(cats[0].name);
      }
    } catch (e) {
      // спробуємо взяти id зі сторінки
    }
    if (!catId) {
      const m = pageHtml.match(/data-cat=["'](\d+)["']/);
      if (m) catId = parseInt(m[1], 10);
    }
    if (!catId) throw new Error(`Новелу «${slug}» не знайдено`);

    // 3. Розділи
    const chapters = await this.loadChapters(catId, count, novelUrl);
    if (!chapters.length) {
      throw new Error('ranobe-novels.ru: сайт не віддав список розділів');
    }

    // 4. Метадані. Якщо на сторінці новели їх немає, беремо зі сторінки
    //    першого розділу: там блок schema:Book є завжди.
    let meta = readBookMeta(pageHtml);
    if (!meta.cover || !meta.summary) {
      try {
        const res = await fetchApi(SITE + chapters[0].path);
        if (res.ok) {
          const extra = readBookMeta(await res.text());
          meta = {
            name: meta.name || extra.name,
            cover: meta.cover || extra.cover,
            author: meta.author || extra.author,
            genres: meta.genres || extra.genres,
            summary: meta.summary || extra.summary,
          };
        }
      } catch (e) {
        // не критично
      }
    }

    const genreLinks = readGenreLinks(pageHtml);
    const genres = genreLinks.length ? genreLinks.join(', ') : meta.genres || '';

    return {
      path: novelPath,
      name: name || meta.name || slug,
      cover: meta.cover || defaultCover,
      summary: meta.summary,
      author: meta.author,
      genres,
      status: /заверш/i.test(genres)
        ? NovelStatus.Completed
        : NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const res = await fetchApi(SITE + chapterPath);
    if (!res.ok) {
      throw new Error(`ranobe-novels.ru: розділ, HTTP ${res.status}`);
    }
    const $ = loadCheerio(await res.text());

    const content = $('#js-full-content');
    if (!content.length) {
      throw new Error(
        'ranobe-novels.ru: текст розділу не знайдено (сайт міг змінити розмітку)',
      );
    }

    // Рекламні вставки й службові блоки всередині тексту
    content
      .find(
        'script, style, noscript, iframe, ins, .js-remove, .code-block, .ai-viewports',
      )
      .remove();

    return content.html() || '';
  }

  resolveUrl = (path: string) => SITE + path;
}

export default new RanobeNovelsPlugin();

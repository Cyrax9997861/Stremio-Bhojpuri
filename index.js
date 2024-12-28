const { addonBuilder, serveHTTP } = require('stremio-addon-sdk')
const fetch = require('node-fetch')
const cheerio = require('cheerio')
const { normalizeText } = require('./utils')

const BASE_URL = 'https://bhojpuriraas.net'
const LOGO_URL = 'https://bhojpuriraas.net/images/BhojpuriRaas.Net_w.png'

let manifest = {
    id: 'org.bhojpuriraas',
    version: '1.0.0',
    name: 'Bhojpuri Raas',
    description: 'Bhojpuri movies from bhojpuriraas.net',
    resources: ['stream', 'meta', 'catalog'],
    types: ['movie'],
    catalogs: [],
    logo: LOGO_URL,
    idPrefixes: ['bhojpuriraas'],
    extra: {
        search: {
            types: ['movie']
        }
    }
}

let builder = null
let catalogUrlMap = new Map();
let movieMetadataMap = new Map();

async function initializeAddon() {
    try {
        const catalogs = await fetchCatalogs()
        manifest.catalogs = catalogs.map(cat => ({
            type: 'movie',
            id: cat.id,
            name: cat.name,
            extra: [{ name: 'search' }]
        }))
        
        builder = new addonBuilder(manifest)
        
        defineMetaHandler()
        defineCatalogHandler()
        defineStreamHandler()
        
        return true
    } catch (error) {
        console.error('Error initializing addon:', error)
        return false
    }
}

async function fetchCatalogs() {
    try {
        let html = await fetchWithRetry(BASE_URL)
        let $ = cheerio.load(html)

        const categoryLink = $("#cateogry > div > div:nth-child(2)").find('a').attr('href');
        const CATEGORY_URL = BASE_URL + categoryLink;
        
        html = await fetchWithRetry(CATEGORY_URL)
        $ = cheerio.load(html)

        const catalogs = []

        const filteredChildren = $(".catList").children().not(":eq(0), :eq(2)")
        
        filteredChildren.each((index, element) => {
            const title = $(element).find('a').text().trim()
            const href = $(element).find('a').attr('href')
            if (title && href) {
                // Apply text normalization to catalog titles
                const normalizedTitle = normalizeText(title)
                catalogs.push({ 
                    id: `bhojpuriraas-${index}`, 
                    name: normalizedTitle, 
                    url: BASE_URL + href 
                })
            }
        })

        return catalogs
    } catch (error) {
        console.error('Error fetching catalogs:', error)
        return []
    }
}

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                redirect: 'follow'
            })
            
            if (response.url.includes('easyupload.io')) {
                console.log('Redirected to easyupload.io:', response.url)
                return response.url
            }
            
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
            return await response.text()
        } catch (e) {
            console.error(`Attempt ${i + 1} failed: ${e.message}`)
            if (i === retries - 1) throw e
        }
    }
}

async function scrapeMovies(catalogUrl, searchQuery = '') {
    try {
        console.log(`Fetching URL: ${catalogUrl}`)
        let allMovies = []
        let currentPage = 1
        let hasNextPage = true

        while (hasNextPage) {
            const pageUrl = `${catalogUrl.replace('/1.html', '')}/${currentPage}.html`
            console.log(`Fetching page ${currentPage}: ${pageUrl}`)
            const html = await fetchWithRetry(pageUrl)
            const $ = cheerio.load(html)
            
            const movies = []
            
            $(".catList").children().each((i, elem) => {
                const title = $(elem).find("a > div > div:nth-child(2)").text().trim()
                const href = $(elem).find('a').attr('href')
                
                if (href) {
                    const id = `bhojpuriraas:${href.split('/').slice(-2, -1)[0]}`
                    const posterSrc = $(elem).find('img').attr('src')
                    const poster = posterSrc ? posterSrc.replace(/_(\d+)\.jpg$/, '_3.jpg') : null
                    
                    if (id && title && poster) {
                        catalogUrlMap.set(id, catalogUrl);
                        
                        const metadata = {
                            id,
                            type: 'movie',
                            name: normalizeText(title),
                            poster,
                            background: poster,
                            logo: poster,
                            description: normalizeText(title),
                            runtime: "120 min",
                            language: "Bhojpuri",
                            country: "IN",
                            genres: ["Bhojpuri"]
                        };
                        movieMetadataMap.set(id, metadata);
                        
                        if (!searchQuery || normalizeText(normalizeText(title), true).includes(normalizeText(normalizeText(searchQuery), true))) {
                            movies.push({ id, title, poster })
                        }
                    }
                }
            })
            
            allMovies = allMovies.concat(movies)
            
            const nextPageLink = $('a:contains("Next >")').attr('href')
            hasNextPage = !!nextPageLink
            currentPage++

            if (currentPage > 8) {
                hasNextPage = false
            }
        }
        
        console.log(`Scraped ${allMovies.length} movies in total`)
        return allMovies
    } catch (error) {
        console.error('Error scraping movies:', error)
        return []
    }
}

function defineCatalogHandler() {
    builder.defineCatalogHandler(async ({ type, id, extra }) => {
        console.log('Request for catalog:', type, id, extra)
        if (type === 'movie' && id.startsWith('bhojpuriraas-')) {
            const catalogs = await fetchCatalogs()
            const catalog = catalogs.find(cat => cat.id === id)
            if (catalog) {
                const searchQuery = extra && extra.search ? extra.search : ''
                const movies = await scrapeMovies(catalog.url, searchQuery)
                
                if (movies.length > 0) {
                    return { 
                        metas: movies.map(movie => movieMetadataMap.get(movie.id))
                    }
                }
            }
        }
        return { metas: [] }
    })
}

function defineMetaHandler() {
    builder.defineMetaHandler(async ({ type, id }) => {
        console.log('Request for meta:', type, id)
        if (type === 'movie') {
            const metadata = movieMetadataMap.get(id)
            if (metadata) {
                return { meta: metadata }
            }
            
            // If metadata is not in memory, try to fetch it
            if (id.startsWith('bhojpuriraas:')) {
                const movieId = id.split(':')[1]
                const catalogUrl = catalogUrlMap.get(id)
                if (catalogUrl) {
                    await scrapeMovies(catalogUrl)
                    return { meta: movieMetadataMap.get(id) }
                }
            }
        }
        return { meta: null }
    })
}

function defineStreamHandler() {
    builder.defineStreamHandler(async ({ type, id }) => {
        console.log('Request for stream:', type, id)
        if (type === 'movie' && id.startsWith('bhojpuriraas:')) {
            try {
                const movieId = id.split(':')[1]
                const metadata = movieMetadataMap.get(id)
                if (!metadata) {
                    console.error(`No metadata found for movie ID: ${id}`)
                    return { streams: [] }
                }

                const streams = await scrapeMovieStream(movieId)
                if (!streams) {
                    return { streams: [] }
                }

                return {
                    streams: streams.map(stream => ({
                        ...stream,
                        title: `${metadata.name} - ${stream.name}`,
                        name: `BhojpuriRaas - ${stream.name}`,
                        behaviorHints: {
                            notWebReady: true,
                            bingeGroup: `bhojpuri-${id}`
                        }
                    }))
                }
            } catch (error) {
                console.error(`Error in stream handler:`, error)
                return { streams: [] }
            }
        }
        return { streams: [] }
    })
}

async function scrapeMovieStream(movieId) {
    try {
        const id = `bhojpuriraas:${movieId}`
        let catalogUrl = catalogUrlMap.get(id);
        if (!catalogUrl) {
            console.error(`No catalog URL found for movie ID: ${id}. Attempting to find it.`);
            const catalogs = await fetchCatalogs();
            for (const catalog of catalogs) {
                await scrapeMovies(catalog.url);
                if (catalogUrlMap.has(id)) {
                    catalogUrl = catalogUrlMap.get(id);
                    break;
                }
            }
            if (!catalogUrl) {
                console.error(`Could not find catalog URL for movie ID: ${id}`);
                return null;
            }
        }

        console.log(`Fetching movie from catalog URL: ${catalogUrl}`);
        const html = await fetchWithRetry(catalogUrl);
        const $ = cheerio.load(html);
        
        let movieElement = $(`.catList a[href*="/${movieId}/"]`).first();
        if (!movieElement.length) {
            console.log(`Movie not found on the initial page. Searching through other pages...`);
            let currentPage = 1;
            let hasNextPage = true;
            while (hasNextPage && !movieElement.length) {
                currentPage++;
                const pageUrl = `${catalogUrl.replace('/1.html', '')}/${currentPage}.html`;
                console.log(`Searching on page ${currentPage}: ${pageUrl}`);
                const pageHtml = await fetchWithRetry(pageUrl);
                const $page = cheerio.load(pageHtml);
                movieElement = $page(`.catList a[href*="/${movieId}/"]`).first();
                hasNextPage = !!$page('a:contains("Next >")').attr('href');
                if (currentPage > 8) hasNextPage = false;
            }
            if (!movieElement.length) {
                console.error(`Could not find movie with ID: ${movieId} in any page`);
                return null;
            }
        }
        
        const href = movieElement.attr('href');
        const urlPath = href.split('/')[1];
        
        const url = `${BASE_URL}/${urlPath}/fl/${movieId}/1.html`;
        console.log(`Fetching stream URL: ${url}`);
        
        const streamPageHtml = await fetchWithRetry(url);
        const $streamPage = cheerio.load(streamPageHtml);
        
        const streams = [];
        
        for (const element of $streamPage('.fileName').toArray()) {
            const quality = $streamPage(element).find('div div span:first-child').text().trim();
            const downloadHref = $streamPage(element).attr('href');
            
            if (downloadHref) {
                const downloadPageUrl = `${BASE_URL}${downloadHref}`;
                console.log(`Fetching download page: ${downloadPageUrl}`);
                
                const downloadPageHtml = await fetchWithRetry(downloadPageUrl);
                const $downloadPage = cheerio.load(downloadPageHtml);
                
                const dwnLinkHref = $downloadPage('.dwnLink').attr('href');
                if (dwnLinkHref) {
                    const redirectUrl = `${BASE_URL}${dwnLinkHref}`;
                    console.log(`Following redirect URL: ${redirectUrl}`);
                    
                    try {
                        const response = await fetch(redirectUrl, {
                            method: 'HEAD',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                            },
                            redirect: 'follow'
                        });
                        
                        console.log(response.url);
                        // Check if it's a direct download URL
                        if (response.url.includes('.mp4')) {
                            console.log(`Found direct download link: ${response.url}`);
                            streams.push({
                                url: response.url,
                                title: quality,
                                name: quality
                            });
                            continue; // Skip easyupload processing for this stream
                        }

                        // If not a direct download, proceed with easyupload processing
                        const easyuploadUrl = await fetchWithRetry(redirectUrl);
                        if (easyuploadUrl && easyuploadUrl.includes('easyupload.io')) {
                            const fileId = easyuploadUrl.split('/').pop();
                            console.log(`Getting easyupload link for file ID: ${fileId}`);
                            
                            const directLink = await getEasyUploadDirectLink(fileId);
                            if (directLink) {
                                console.log(`Found easyupload direct link (${quality}):`, directLink);
                                
                                streams.push({
                                    url: directLink,
                                    title: quality,
                                    name: quality
                                });
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing stream URL: ${error.message}`);
                        continue;
                    }
                }
            }
        }

        if (streams.length === 0) {
            console.error(`No streams found for movie ID: ${movieId}`);
            return null;
        }
        
        console.log(`Found ${streams.length} streams for movie ID: ${movieId}`);
        return streams;
    } catch (error) {
        console.error(`Error scraping stream for movie ID ${movieId}:`, error);
        return null;
    }
}

async function getEasyUploadDirectLink(fileId) {
    try {
        console.log(`Getting download link for file: ${fileId}`)
        
        const formData = new URLSearchParams()
        formData.append('type', 'download-token')
        formData.append('url', fileId)
        formData.append('value', '')
        formData.append('captchatoken', 'gZx5mn2DRr4wxy2Bvj5FbjtWkZaTeWFC')
        formData.append('method', 'regular')

        const response = await fetch('https://eu4.easyupload.io/action.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Origin': 'https://easyupload.io',
                'Referer': `https://easyupload.io/${fileId}`
            },
            body: formData.toString()
        })

        const data = await response.json()
        console.log('API response:', data)

        if (data.status && data.download_link) {
            return data.download_link.trim()
        } else if (data.error) {
            throw new Error(`API error: ${data.error}`)
        } else {
            throw new Error('Unexpected API response format')
        }
    } catch (error) {
        console.error('Error getting direct download link:', error)
        console.error('Error details:', error.message)
        return null
    }
}

async function runAddon() {
    const initialized = await initializeAddon()
    if (!initialized) {
        console.error('Failed to initialize addon')
        return
    }

    serveHTTP(builder.getInterface(), { port: 7000 })
        .then(() => {
            console.log('Addon running on port 7000')
        })
        .catch(error => {
            console.error('Failed to start addon:', error)
        })
}

runAddon()


// lib/catalog-copy.js — tidy every live Shopify listing for the website, the Shop
// app, Google/Meta/TikTok and AI shopping agents (ChatGPT, Copilot…).
//
// Per active product, only where something is missing or wrong:
//   • description — empty, or the eBay template (eBay wording, related-item cards
//     with stale prices) → clean website copy from lib/listing-copy.js. The old
//     HTML is kept in the metafield razoryn.description_backup.
//   • product type — empty → the part type ("Headlight", "Parcel Shelf"…)
//   • category — none, or only "Vehicles & Parts" → the matching Shopify category
//   • SEO title / meta description — empty → lib/seo.js
// Good existing copy is never touched, so it's safe to run again (nightly + on demand).
const { query } = require('../db');
const brand = require('./brand');
const listingCopy = require('./listing-copy');
const seo = require('./seo');

// Pure: what to change on one product (Shopify GraphQL node shape from
// services/shopify.listProductsForCopy). Returns null when nothing to do.
function planChanges(p, brandCfg = brand) {
  const out = {};
  const title = p.title || '';
  const tags = p.tags || [];
  const pn = p.pn?.value || '';
  if (listingCopy.needsNewDescription(p.descriptionHtml)) {
    out.descriptionHtml = listingCopy.buildDescriptionHtml({
      title, partNumber: pn, altPartNumbers: p.alt?.value, position: p.pos?.value,
      secondaryPosition: p.pos2?.value, finish: p.fin?.value, tags,
    }, brandCfg);
    if (String(p.descriptionHtml || '').trim() && !p.backup) out.backupHtml = p.descriptionHtml;
  }
  const info = listingCopy.partTypeInfo(title);
  if (!String(p.productType || '').trim() && info.partType) out.productType = info.partType;
  const levels = String(p.category?.fullName || '').split('>').filter(s => s.trim()).length;
  if (levels < 3 && info.categoryQuery) out.categoryQuery = info.categoryQuery;
  // Shopify reports an SEO title that's the same as the product title as empty,
  // so only write a title when ours differs — otherwise it'd be rewritten nightly.
  const curTitle = p.seo?.title || '', curDesc = p.seo?.description || '';
  const s = (!curTitle || !curDesc) ? seo.buildSeo({ title, part_number: pn }, brandCfg) : null;
  const needTitle = s && !curTitle && s.pageTitle && s.pageTitle !== title.trim();
  if (s && (!curDesc || needTitle)) {
    out.seo = { ...(needTitle ? { title: s.pageTitle } : (curTitle ? { title: curTitle } : {})), description: curDesc || s.metaDescription };
  }
  return Object.keys(out).length ? out : null;
}

let status = { state: 'idle', startedAt: null, finishedAt: null, checked: 0, changed: 0, failed: 0,
  descriptions: 0, types: 0, categories: 0, seo: 0, sampleError: null, dryRun: false, samples: [] };
function getStatus() { return status; }

async function run({ dryRun = false, sampleSize = 10, delayMs = 350 } = {}) {
  if (status.state === 'running') return { alreadyRunning: true, status };
  const shopify = require('../services/shopify');
  if (!shopify.isConfigured()) return { error: 'shopify_not_configured' };
  status = { state: 'running', startedAt: Date.now(), finishedAt: null, checked: 0, changed: 0, failed: 0,
    descriptions: 0, types: 0, categories: 0, seo: 0, sampleError: null, dryRun, samples: [] };
  try {
    let after = null;
    do {
      const page = await shopify.listProductsForCopy(after);
      for (const p of page.nodes || []) {
        status.checked++;
        const plan = planChanges(p);
        if (!plan) continue;
        let categoryId = null;
        if (plan.categoryQuery) {
          try {
            const c = await shopify.findTaxonomyCategory(plan.categoryQuery);
            // Only ever a car-parts category (the lookup can fall back to anything).
            if (c && /^Vehicles\s*&\s*Parts\s*>/i.test(c.fullName || '')) categoryId = c.id;
          } catch (_) {}
        }
        // Only a category to fix, and no car-parts category found → nothing to write.
        if (!plan.descriptionHtml && !plan.productType && !plan.seo && !categoryId) continue;
        if (status.samples.length < sampleSize) {
          status.samples.push({ id: p.id, title: p.title, productType: plan.productType || null,
            category: plan.categoryQuery || null, seo: plan.seo || null,
            description: plan.descriptionHtml ? plan.descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) : null });
        }
        if (plan.descriptionHtml) status.descriptions++;
        if (plan.productType) status.types++;
        if (categoryId) status.categories++;
        if (plan.seo) status.seo++;
        status.changed++;
        if (dryRun) continue;
        try {
          await shopify.updateProductCopy(p.id, { descriptionHtml: plan.descriptionHtml, productType: plan.productType,
            categoryId, seo: plan.seo, backupHtml: plan.backupHtml });
          if (delayMs) await new Promise(r => setTimeout(r, delayMs));   // stay well inside the API rate limit
        } catch (e) {
          status.failed++;
          if (!status.sampleError) status.sampleError = `${p.title}: ${e.message}`;
        }
      }
      after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    status.state = 'done';
  } catch (e) {
    status.state = 'error';
    status.sampleError = e.message;
  }
  status.finishedAt = Date.now();
  if (!dryRun && status.changed) {
    console.log(`[catalog-copy] ${status.changed} listing(s) updated — ${status.descriptions} descriptions, ${status.types} types, ${status.categories} categories, ${status.seo} SEO (${status.failed} failed)`);
  }
  return status;
}

// First run after this ships (Razoryn): clean up the whole catalogue once.
async function runOnce() {
  if (brand.code !== 'razoryn') return { skipped: 'brand' };
  await query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const cur = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
  if (cur.catalogCopy?.firstRunAt) return { skipped: 'already_run' };
  const out = await run({});
  if (out && out.state === 'done') {
    const now = (await query(`SELECT data FROM app_settings WHERE id = 1`)).rows[0]?.data || {};
    await query(`UPDATE app_settings SET data = $1::jsonb, updated_at = now() WHERE id = 1`,
      [JSON.stringify({ ...now, catalogCopy: { ...(now.catalogCopy || {}), firstRunAt: new Date().toISOString(), firstRun: { changed: out.changed, failed: out.failed } } })]);
  }
  return out;
}

module.exports = { planChanges, run, runOnce, getStatus };

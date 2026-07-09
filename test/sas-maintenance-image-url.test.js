'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pickBestSasMaintenanceImageUrl, mapSasMaintenanceImage } = require('../src/sas-bridge');

describe('pickBestSasMaintenanceImageUrl', () => {
  it('prefers original/full URLs over thumbnail paths', () => {
    const url = pickBestSasMaintenanceImageUrl({
      url: 'https://example.com/tmb/medium_thumbnail-abc.jpg',
      original_url: 'https://djttbrw0ufia8.cloudfront.net/media/image_ABC.jpg',
    });
    assert.equal(url, 'https://djttbrw0ufia8.cloudfront.net/media/image_ABC.jpg');
  });

  it('maps maintenance image metadata', () => {
    const mapped = mapSasMaintenanceImage({
      id: 42,
      url: 'https://example.com/photo.jpg',
      width: 800,
      height: 1200,
    });
    assert.equal(mapped.id, 42);
    assert.equal(mapped.url, 'https://example.com/photo.jpg');
    assert.equal(mapped.width, 800);
    assert.equal(mapped.height, 1200);
    assert.equal(mapped.source, 'prod');
  });
});

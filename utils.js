// Character replacement dictionary
const characterReplacements = {
  '@': 'a',
  '0': 'o',
  // Add more replacements as needed
};

// Function to normalize text for searching
function normalizeText(text, forSearch = false) {
  const normalized = text.replace(/[@0]/g, char => characterReplacements[char] || char);
  return forSearch ? normalized.toLowerCase() : normalized;
}

module.exports = {
  normalizeText,
  characterReplacements
};


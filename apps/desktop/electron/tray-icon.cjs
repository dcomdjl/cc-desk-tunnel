// A small monochrome version of the application's terminal mark for the macOS menu bar.
function terminalTemplate(nativeImage) {
  const width = 18;
  const pixels = Buffer.alloc(width * width * 4);
  const dot = (x, y) => {
    for (let dx = 0; dx < 2; dx++)
      for (let dy = 0; dy < 2; dy++) pixels[((y + dy) * width + x + dx) * 4 + 3] = 255;
  };
  for (let step = 0; step < 5; step++) {
    dot(3 + step, 3 + step);
    dot(7 - step, 7 + step);
  }
  for (let x = 9; x < 15; x++) dot(x, 11);
  const image = nativeImage.createFromBitmap(pixels, { width, height: width });
  image.setTemplateImage(true);
  return image;
}
module.exports = { terminalTemplate };

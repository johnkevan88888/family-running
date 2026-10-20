# Entirely synthetic face-detection fixture

`synthetic-runners-ai.png` was generated on 20 October 2026 using the built-in
image-generation tool. It depicts three fictional adults, not the owner, other
athletes, stock-photo subjects or any supplied real photograph. No reference
image was used. Do not infer actual identities from this image.

SHA-256: `35b6566479871ad6e72465699a2f3a6d3b0d4888fcf924333ebb4826bae7b4db`.

Purpose: exercise the actual pinned browser detector on positive synthetic
examples. Tests may derive smaller images, a single-face crop and EXIF-oriented
JPEG variants from these generated pixels. Empty diagrams/fault injection alone
are not proof that the actual model can detect faces. All fixture files remain
outside the public artifact; no image is uploaded to a remote Gallery service.

Generation prompt (built-in tool, not CLI):

> Use case: photorealistic-natural. Asset type: an entirely synthetic software
> test fixture for a face detector, not a real photograph and not depicting any
> real person. Generate a square 1024x1024 image showing THREE distinct fictional
> adult runners side by side, head and upper torso, facing directly at camera with
> clearly separated unobstructed faces. Plain light gray studio background, even
> diffuse illumination, realistic facial structure and natural skin detail, eyes
> nose and mouth clear, no sunglasses, hats or face coverings. Different simple
> solid-color sport shirts, no logos. Each whole head including hair and chin
> fully inside image, no overlaps. Three faces at approximately x=20%,50%,80% and
> y=35%, each face about20%of imagewidth. No names, no text, no famous people, no
> references to uploaded images. The image will be labelled AI-generated synthetic
> test data in separate provenance metadata.

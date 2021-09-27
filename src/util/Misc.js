import {shapeArea} from '@recogito/annotorious/src/selectors';

export const range = (len, start=0) => [...new Array(len)].map((_, i) => i + start);

export const getURL = string => new URL(string, document.baseURI);

export const pointInsideBounds = (bounds, point) => {
  const {x, y} = point;
  const x1 = bounds.x;
  const y1 = bounds.y;
  const x2 = bounds.x + bounds.width;
  const y2 = bounds.y + bounds.height;
  return x >= x1 && y >= y1 && x <= x2 && y <= y2;
};

export const bboxInsideImage = (image, bbox) => {
  const {x, y, width, height} = bbox;
  return x >= 0 && y >= 0 && x + width <= image.naturalWidth && y + height <= image.naturalHeight;
}

export const sortByShapeArea = annotations => {
    annotations.sort((a, b) => {
      const areaB = shapeArea(b, this._selectLayerByTarget(b.target)[1]._env.image);
      const areaA = shapeArea(a, this._selectLayerByTarget(a.target)[1]._env.image);
      return  areaB - areaA;
    });
}
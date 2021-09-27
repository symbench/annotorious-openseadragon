import EventEmitter from 'tiny-emitter';
import OpenSeadragon from 'openseadragon';
import { SVG_NAMESPACE, addClass } from '@recogito/annotorious/src/util/SVG';
import DrawingTools from '@recogito/annotorious/src/tools/ToolsRegistry';
import Crosshair from '@recogito/annotorious/src/Crosshair';
import { drawShape, shapeArea } from '@recogito/annotorious/src/selectors';
import { format } from '@recogito/annotorious/src/util/Formatting';
import { isTouchDevice, enableTouchTranslation } from '@recogito/annotorious/src/util/Touch';
import { getSnippet } from './util/ImageSnippet';
import {range, getURL, pointInsideBounds, bboxInsideImage, sortByShapeArea} from './util/Misc';

/**
 * Code shared between (normal) OSDAnnotationLayer and
 * GigapixelAnnotationLayer
 */
export class AnnotationLayer extends EventEmitter {

  constructor(props) {
    super();

    this.viewer = props.viewer;

    this.env = props.env;

    this.readOnly = props.config.readOnly;
    this.headless = props.config.headless;
    this.formatter = props.config.formatter;

    this.disableSelect = props.disableSelect;

    this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');

    if (isTouchDevice()) {
      this.svg.setAttribute('class', 'a9s-annotationlayer a9s-osd-annotationlayer touch');
      enableTouchTranslation(this.svg);
    } else {
      this.svg.setAttribute('class', 'a9s-annotationlayer a9s-osd-annotationlayer');
    }    

    this.g = document.createElementNS(SVG_NAMESPACE, 'g');
    this.svg.appendChild(this.g);
    
    this.viewer.canvas.appendChild(this.svg);

    this.viewer.addHandler('animation', () => this.resizeAnnotationLayers());
    this.viewer.addHandler('rotate', () => this.resizeAnnotationLayers());
    this.viewer.addHandler('resize', () => this.resizeAnnotationLayers());
    this.viewer.addHandler('flip', () => this.resizeAnnotationLayers());

    const onLoad = () => {
      props.env.image = this._getTiledImageEnv(this.viewer.world.getItemAt(0));

      if (props.config.crosshair) {
        this.crosshair = new Crosshair(this.g, x, y);
        addClass(this.svg, 'has-crosshair');
      }

      const remainingImages = this._getRemainingTiledImages();
      if (remainingImages) {
        remainingImages.forEach(tiledImage => {
          const env = Object.assign({}, props.env);
          env.image = this._getTiledImageEnv(tiledImage);
          const g = document.createElementNS(SVG_NAMESPACE, 'g');
          const tool = new DrawingTools(g, props.config, env);
          this.annotationLayers.push([g, tool]);
        });
      }

      this._addDeferredAnnotations();

      this.resizeAnnotationLayers();
    }

    // Store image properties on open (incl. after page change) and on addTiledImage
    this.viewer.addHandler('open', onLoad);
    this.viewer.world.addHandler('add-item', onLoad);

    // Or: if Annotorious gets initialized on a loaded image
    if (this.viewer.world.getItemAt(0))
      onLoad();

    this.selectedShape = null;

    this.tools = new DrawingTools(this.g, props.config, props.env);

    this.annotationLayers = [[this.g, this.tools]];
    this.deferredAnnotations = [];
    
    this._deselectOnClickOutside();
    this._initDrawingMouseTracker();
  }

  _addDeferredAnnotations = () => {
    this.deferredAnnotations.forEach(this.addAnnotation);
    this.deferredAnnotations = [];
  }

  _getTiledImageEnv = (tiledImage) => {
    const { x, y } = this.viewer.world.getItemAt(0).source.dimensions;
    return {
      src: tiledImage.source['@id'] || new URL(tiledImage.source.url, document.baseURI).href,
      naturalWidth: x,
      naturalHeight: y,
    };
  }

  _getRemainingTiledImages = () => {
    const osdInMultiImageMode = () => {
        const count = this.viewer.world.getItemCount();
        return count > 1 ? count: 0;
      }

      if (osdInMultiImageMode()) {
        return range(this.viewer.world.getItemCount()-1, 1).map(index => {
            return this.viewer.world.getItemAt(index);
        });
      }
  }

  _getTiledImages = () => {
    return range(this.viewer.world.getItemCount())
      .map(idx => {
        console.log(this.viewer.world.getItemAt(idx));
        return this.viewer.world.getItemAt(idx);
      });
  }

  _getTiledImageFromURL = url => {
    const allImages = this._getTiledImages();
    const match = allImages
      .find(tiledImage => getURL(tiledImage.source.url).href === getURL(url).href);
    // Fall back to first image in the viewer
    return match || allImages[0];
  }

  _selectLayer = position => {
    const allImages = this._getTiledImages();
    return allImages.find((tiledImage, index) => {
      const bounds = tiledImage.getBounds(true);
      const viewPortCoordinates = this.viewer.viewport.viewerElementToViewportCoordinates(position);
      return pointInsideBounds(bounds, viewPortCoordinates) ? this.annotationLayers[index] : this.annotationLayers[0];
    });
  }

  _selectLayerByTarget = target => {
    if (!target) {
      return this.annotationLayers[0];
    } else {
      const tiledImage = this._getTiledImageFromURL(target.source);
      return this.viewer.world.getIndexOfItem(tiledImage);
    }
  }

  /** Adds handler logic to deselect when clicking outside a shape **/
  _deselectOnClickOutside = () => {
    // Unfortunately, creating a selection (=drag) ALSO 
    // creates a click event - ignore in this case.
    let completedSelection = false;

    this.tools.on('complete', () => {
      completedSelection = true;
      setTimeout(() => completedSelection = false, 10);
    });

    this.svg.addEventListener('click', evt => {
      const annotation = evt.target.closest('.a9s-annotation');
      
      // Click outside, no drawing in progress
      if (!annotation && !this.tools.current?.isDrawing) {

        // Not a new selection - deselect
        if (!completedSelection) {
          this.deselect();
          this.emit('select', {});
        } 
      }
    });
  }

  /** Initializes the OSD MouseTracker used for drawing **/
  _initDrawingMouseTracker = () => {

    let started = false;

    this.mouseTracker = new OpenSeadragon.MouseTracker({
      element: this.svg,

      pressHandler: evt => {
        const activeLayer = this._selectLayer(evt.position) || this.annotationLayers[0];
        this.tools = activeLayer[1];
        if (!this.tools.current.isDrawing) {
          this.tools.current.start(evt.originalEvent);
          // this.tools.current.scaleHandles(1 / this.currentScale());
        }
      },

      moveHandler: evt => {
        if (this.tools.current.isDrawing) {
          const { x , y } = this.tools.current.getSVGPoint(evt.originalEvent);
          this.tools.current.onMouseMove(x, y, evt.originalEvent);

          if (!started) {
            this.emit('startSelection', { x , y });
            started = true;
          }
        }
      },

      releaseHandler: evt => {
        if (this.tools.current.isDrawing) {
          const { x , y } = this.tools.current.getSVGPoint(evt.originalEvent);
          this.tools.current.onMouseUp(x, y, evt.originalEvent);
        }

        started = false;
      }
    }).setTracking(false);

    // Keep tracker disabled until Shift is held
    document.addEventListener('keydown', evt => {
      if (evt.which === 16 && !this.selectedShape) { // Shift
        this.mouseTracker.setTracking(!this.readOnly);
      }
    });

    document.addEventListener('keyup', evt => {
      if (evt.which === 16 && !this.tools.current.isDrawing) {
        this.mouseTracker.setTracking(false);
      }
    });

  }

  _removeMouseListeners = shape => {
    // Remove mouseLeave/mouseEnter listener - otherwise
    // they'll fire when shapes are added/removed to the
    // DOM (when the mouse is over them)
    for (let listener in shape.listeners) {
      shape.removeEventListener(listener, shape.listeners[listener]);
    }
  }

  _attachMouseListeners = (shape, annotation) => {
    const zoomGesture = this.viewer.gestureSettingsByDeviceType('mouse').clickToZoom;

    const onMouseEnter = () => {
      this.viewer.gestureSettingsByDeviceType('mouse').clickToZoom = false;

      if (!this.tools?.current.isDrawing)
        this.emit('mouseEnterAnnotation', annotation, shape);
    };

    const onMouseLeave = () => {
      this.viewer.gestureSettingsByDeviceType('mouse').clickToZoom = zoomGesture;

      if (!this.tools?.current.isDrawing)
        this.emit('mouseLeaveAnnotation', annotation, shape);
    };

    // Common click/tap handler
    const onClick = evt => {
      this.viewer.gestureSettingsByDeviceType('mouse').clickToZoom = false;

      // Unfortunately, click also fires after drag, which means
      // a new selection on top of this shape will be interpreted 
      // as click. Identify this case and prevent the default
      // selection action!
      const isSelection = this.selectedShape?.annotation.isSelection &&
        this.selectedShape === evt.target.closest('.a9s-selection');

      if (!isSelection && !this.disableSelect && this.selectedShape?.element !== shape)
        this.selectShape(shape);
      
      if (this.disableSelect)
        this.emit('clickAnnotation', shape.annotation, shape);
    }

    shape.addEventListener('mouseenter', onMouseEnter);
    shape.addEventListener('mouseleave', onMouseLeave);
    shape.addEventListener('click', onClick);
    shape.addEventListener('touchend', onClick);

    // Store, so we can remove later
    shape.listeners = {
      mouseenter: onMouseEnter,
      mouseleave: onMouseLeave,
      click: onClick,
      touchend: onClick
    }
  }

  addAnnotation = annotation => {
    if (!this.viewer.isOpen()) {
      this.deferredAnnotations.push(annotation);
      return;
    }

    const [g, tools] = this._selectLayerByTarget(annotation.target);
    const shape = drawShape(annotation, tools._env.image);
    shape.setAttribute('class', 'a9s-annotation');

    shape.setAttribute('data-id', annotation.id);
    shape.annotation = annotation;

    this._attachMouseListeners(shape, annotation);

    g.appendChild(shape);

    format(shape, annotation, this.formatter);

    this.scaleFormatterElements(shape);
  }

  addDrawingTool = plugin =>
    this.tools.registerTool(plugin);

  addOrUpdateAnnotation = (annotation, previous) => {
    if (this.selectedShape?.annotation === annotation || this.selectedShape?.annotation == previous)
      this.deselect();
  
    if (previous)
      this.removeAnnotation(annotation);

    this.removeAnnotation(annotation);
    this.addAnnotation(annotation);

    // Make sure rendering order is large-to-small
    this.redraw();
  }

  currentScale = (item) => {
    const containerWidth = this.viewer.viewport.getContainerSize().x;
    const zoom = this.viewer.viewport.getZoom(true);
    let contentFactor;
    if (item) {
      contentFactor = item.getContentSize().x / item.getBounds().width;
    } else {
      contentFactor = this.viewer.world.getContentFactor();
    }
    return zoom * containerWidth / contentFactor;
  }

  deselect = skipRedraw => {
    this.tools?.current.stop();
    
    if (this.selectedShape) {
      const { annotation } = this.selectedShape;

      if (this.selectedShape.destroy) {
        // Modifiable shape: destroy and re-add the annotation
        this.selectedShape.mouseTracker.destroy();
        this.selectedShape.destroy();

        if (!annotation.isSelection)
          this.addAnnotation(annotation);

          if (!skipRedraw)
            this.redraw();
      }
      
      this.selectedShape = null;
    }
  }

  destroy = () => {
    this.deselect();
    this.svg.parentNode.removeChild(this.svg);
  }

  findShape = annotationOrId => {
    const id = annotationOrId?.id ? annotationOrId.id : annotationOrId;
    const annotationSVGGroups = this.annotationLayers.map(([g, _]) => g);
    return annotationSVGGroups
      .map(g => g.querySelector(`.a9s-annotation[data-id="${id}"]`))
      .find(shape => !!shape);
  }

  fitBounds = (annotationOrId, immediately) => {
    const shape = this.findShape(annotationOrId);
    if (shape) {
      const annotation = shape.annotation;
      const tileSource = this._getTiledImageFromURL(annotation.target.source);
      const { x, y, width, height } = shape.getBBox(); // SVG element bounds, image coordinates
      const rect = tileSource.imageToViewportRectangle(x, y, width, height);
      this.viewer.viewport.fitBounds(rect, immediately);
    }    
  }

  _getAnnotationShapes = () => {
    return this.annotationLayers
        .map(([g, _]) => Array.from(g.querySelectorAll('.a9s-annotation')));
  }

  getAnnotations = () => {
    return this._getAnnotationShapes()
      .flat().map(s => s.annotation);
  }

  getSelectedImageSnippet = () => {
    if (this.selectedShape) {
      const shape = this.selectedShape.element ?? this.selectedShape;
      return getSnippet(this.viewer, shape);
    }
  }

  init = annotations => {
    // Clear existing
    this.deselect();

    const shapes = this._getAnnotationShapes();
    const svgLayers = this.annotationLayers.map(([g, _]) => g);
    svgLayers.forEach((g, index) => shapes[index].forEach(g.removeChild));

    // Add
    sortByShapeArea(shapes.map(s => s.annotation));
    annotations.forEach(this.addAnnotation);
  }

  listDrawingTools = () =>
    this.tools.listTools();

  overrideId = (originalId, forcedId) => {
    // Update SVG shape data attribute
    const shape = this.findShape(originalId);
    shape.setAttribute('data-id', forcedId);

    // Update annotation
    const { annotation } = shape;

    const updated = annotation.clone({ id : forcedId });
    shape.annotation = updated;

    return updated;
  }

  panTo = (annotationOrId, immediately) => {
    const shape = this.findShape(annotationOrId);
    if (shape) {
      const { top, left, width, height } = shape.getBoundingClientRect();

      const x = left + width / 2 + window.scrollX;
      const y = top + height / 2 + window.scrollY;
      const center = this.viewer.viewport.windowToViewportCoordinates(new OpenSeadragon.Point(x, y));

      this.viewer.viewport.panTo(center, immediately);
    }    
  }

  redraw = () => {
    // The selected annotation shape
    // const selected = this.g.querySelector('.a9s-annotation.selected');
    //
    // // All other shapes and annotations
    // const unselected = Array.from(this.g.querySelectorAll('.a9s-annotation:not(.selected)'));
    // const annotations = unselected.map(s => s.annotation);
    // annotations.sort((a, b) => shapeArea(b, this.env.image) - shapeArea(a, this.env.image));
    let selected, selectedParentLayer, annotations = [];
    this.annotationLayers.forEach(([g, _]) => {
      selectedParentLayer = g;
      selected = g.querySelector('.a9s-annotation.selected');
      const unselected = Array.from(g.querySelectorAll('.a9s-annotation:not(.selected)'));
      annotations.push(...unselected.map(s => s.annotation));
       // Clear unselected annotations
      unselected.forEach(g.removeChild);
    });


    // Redraw after sort
    sortByShapeArea(annotations);
    annotations.forEach(this.addAnnotation);

    // Then re-draw the selected on top, if any
    if (selected) {
      // Editable shapes might be wrapped in additional group
      // elements (mask!), we need to get the top-level wrapper 
      // of .a9s-annotation.selected that sits directly 
      // beneath this.g
      let toRedraw = selected;
      
      while (toRedraw.parentNode !== selectedParentLayer)
        toRedraw = toRedraw.parentNode;

      selectedParentLayer.appendChild(toRedraw);
    } 
  }
  
  removeAnnotation = annotationOrId => {
    // Removal won't work if the annotation is currently selected - deselect!
    const id = annotationOrId.type ? annotationOrId.id : annotationOrId;

    if (this.selectedShape?.annotation.id === id)
      this.deselect();
      
    const toRemove = this.findShape(annotationOrId);

    if (toRemove) {
      if (this.selectedShape?.annotation === toRemove.annotation)
        this.deselect();

      toRemove.parentNode.removeChild(toRemove);
    }
  }

  resizeAnnotationLayers = () => {
    this.annotationLayers.forEach(([g, tool], index) => {
      const item = this.viewer.world.getItemAt(index);
      const imageBbox = item.getBounds(true);
      this.resize(g, item, new OpenSeadragon.Point(imageBbox.x, imageBbox.y));
    });
  }

  resize(g, item, viewPortPoint) {
    const flipped = this.viewer.viewport.getFlip();

    const p = this.viewer.viewport.pixelFromPoint(viewPortPoint, true);
    if (flipped)
      p.x = this.viewer.viewport._containerInnerSize.x - p.x;

    const scaleY = this.currentScale(item);
    const scaleX = flipped ? - scaleY : scaleY;
    const rotation = this.viewer.viewport.getRotation();

    g.setAttribute('transform', `translate(${p.x}, ${p.y}) scale(${scaleX}, ${scaleY}) rotate(${rotation})`);

    this.scaleFormatterElements(null, item);

    if (this.selectedShape) {
      if (this.selectedShape.element) { // Editable shape
        this.selectedShape.scaleHandles(1 / scaleY);
        this.emit('viewportChange', this.selectedShape.element);
      } else {
        this.emit('viewportChange', this.selectedShape); 
      }       
    }

    if (this.tools?.current.isDrawing)
      this.tools.current.scaleHandles(1 / scaleY);
  }
  
  scaleFormatterElements = (opt_shape, item) => {
    const scale = 1 / this.currentScale(item);

    if (opt_shape) {
      const el = opt_shape.querySelector('.a9s-formatter-el');
      if (el)
        el.firstChild.setAttribute('transform', `scale(${scale})`);
    } else {
      const elements = this.annotationLayers
        .flatMap(([g, _]) => Array.from(g.querySelectorAll('.a9s-formatter-el')));
      elements.forEach(el =>
        el.firstChild.setAttribute('transform', `scale(${scale})`));
    }
  }

  selectAnnotation = (annotationOrId, skipEvent) => {
    if (this.selectedShape)
      this.deselect();

    const selected = this.findShape(annotationOrId);

    if (selected) {
      this.selectShape(selected, skipEvent);

      const element = this.selectedShape.element ? 
        this.selectedShape.element : this.selectedShape;

      return { annotation: selected.annotation, element };
    } else {
      this.deselect();
    }
  }

  selectShape = (shape, skipEvent) => {
    if (!skipEvent && !shape.annotation.isSelection)
      this.emit('clickAnnotation', shape.annotation, shape);
  
    // Don't re-select
    if (this.selectedShape?.annotation === shape.annotation)
      return;

    // If another shape is currently selected, deselect first
    if (this.selectedShape && this.selectedShape.annotation !== shape.annotation)
      this.deselect(true);

    const { annotation } = shape;

    const readOnly = this.readOnly || annotation.readOnly;

    if (!(readOnly || this.headless)) {
      this._removeMouseListeners(shape);

      setTimeout(() => {
        shape.parentNode.removeChild(shape);

        // Fire the event AFTER the original shape was removed. Otherwise,
        // people calling `.getAnnotations()` in the `onSelectAnnotation` 
        // handler will receive a duplicate annotation
        // (See issue https://github.com/recogito/annotorious-openseadragon/issues/63)
        if (!skipEvent)
          this.emit('select', { annotation, element: this.selectedShape.element });
      }, 1);
      const annotationLayer = this._selectLayerByTarget(annotation.target) || this.annotationLayers[0];
      const toolForAnnotation = annotationLayer[1].forAnnotation(annotation);
      this.selectedShape = toolForAnnotation.createEditableShape(annotation);
      this.selectedShape.scaleHandles(
        1 / this.currentScale(
          null, this._getTiledImageFromURL(annotation.target.source)
        )
      );

      this.scaleFormatterElements(this.selectedShape.element);

      this.selectedShape.element.annotation = annotation;     

      // If we attach immediately 'mouseEnter' will fire when the editable shape
      // is added to the DOM!
      setTimeout(() => {
        // Can be undefined in headless mode, when saving immediately
        if (this.selectedShape)
          this._attachMouseListeners(this.selectedShape.element, annotation);
      }, 10);

      // Disable normal OSD nav
      const editableShapeMouseTracker = new OpenSeadragon.MouseTracker({
        element: this.svg
      }).setTracking(true);

      // En-/disable OSD nav based on hover status
      this.selectedShape.element.addEventListener('mouseenter', evt =>
        editableShapeMouseTracker.setTracking(true));

      this.selectedShape.element.addEventListener('mouseleave', evt =>
        editableShapeMouseTracker.setTracking(false));

      this.selectedShape.mouseTracker = editableShapeMouseTracker;

      this.selectedShape.on('update', fragment =>
        this.emit('updateTarget', this.selectedShape.element, fragment));
    } else {
      this.selectedShape = shape;

      if (!skipEvent)
        this.emit('select', { annotation, element: shape, skipEvent });   
    }
  }

  setDrawingEnabled = enable =>
    this.mouseTracker?.setTracking(enable && !this.readOnly);

  setDrawingTool = shape => {
    if (this.tools) {
      this.tools.current?.stop();
      this.tools.setCurrent(shape);
    }
  }

  setVisible = visible => {
    if (visible) {
      this.svg.style.display = null;
    } else {
      this.deselect();
      this.svg.style.display = 'none';
    }
  }

}

export default class OSDAnnotationLayer extends AnnotationLayer {

  constructor(props) {
    super(props);

    this.annotationLayers.forEach(([g, tools]) => {
      tools.on('complete', shape => {
        if(bboxInsideImage(tools._env.image), shape.getBBox()){
          this.selectShape(shape);
          this.emit('createSelection', shape.annotation);
        }
        this.mouseTracker.setTracking(false);
      });
    });
  }

}
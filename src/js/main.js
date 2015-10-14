requirejs([
    '../3rdparty/audiostreamsource',
    '../3rdparty/codemirror/lib/codemirror',
    '../3rdparty/colorutils',
    '../3rdparty/cssparse',
    '../3rdparty/glsl',
    '../3rdparty/twgl',
    '../3rdparty/notifier',
    './misc',
    './strings',
  ], function(
     audioStreamSource,
     CodeMirror,
     colorUtils,
     cssParse,
     glsl,
     twgl,
     Notifier,
     misc,
     strings
  ) {

  "use strict";

  var $ = document.querySelector.bind(document);
  var gl = twgl.getWebGLContext(document.getElementById("c"), { alpha: false });
  var _pauseIcon = "❚❚";
  var _playIcon = "▶";
  var editorElem = $("#editor");
  var soundElem = $("#sound");
  var playElem = $("#play");
  var playNode = document.createTextNode(_playIcon);
  playElem.appendChild(playNode);

  var q = misc.parseUrlQuery();
  var sets = {
    default: {
      num: 10000,
      mode: "LINES",
      sound: "",
      lineSize: "NATIVE",
      backgroundColor: [0, 0, 0, 1],
      shader: $("#vs").text,
    },
    audio: {
      num: 5000,
      mode: "LINES",
      sound: "https://soundcloud.com/djapsara/apsara-terminal-zerothree-music-real-prog",
      lineSize: "NATIVE",
      backgroundColor: [0, 0, 0, 1],
      shader: $("#vs2").text,
    },
  };
  var settings = sets[q.settings];
  if (!settings) {
    settings = sets.default;
  }

  var sc = window.SC || new function() {
    function noop() {
      console.log("noop");
    };
    this.initialize = noop;
    this.stream = noop;
  }

  var notifier = new Notifier({
    timeout: 7.5,
    container: document.body,
  });
  function addNotification(msg) {
    notifier.add({text: msg});
  }

  // There's really no good way to tell which browsers fail.
  // Right now Safari doesn't expose AudioContext (it's still webkitAudioContext)
  // so my hope is whenever they get around to actually supporting the 3+ year old
  // standard that things will actually work.
  var shittyBrowser = window.AudioContext === undefined && /iPhone|iPad|iPod/.test(navigator.userAgent);
  var context = new (window.AudioContext || window.webkitAudioContext)();
  var analyser = context.createAnalyser();
  analyser.connect(context.destination);

  var maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  var soundTexBuffer = new Uint8Array(Math.min(maxTextureSize, analyser.frequencyBinCount));
  var soundTexSpec = {
    src: soundTexBuffer,
    height: 1,
    min: gl.LINEAR,
    mag: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
    format: gl.ALPHA,
  }
  var soundTex = twgl.createTexture(gl, soundTexSpec);

  var g = {
    maxCount: 100000,
    mode: gl.LINES,
    time: 0,
    mouse: [0, 0],
    shaderSuccess: false,
    vsHeader: $("#vs-header").text,
    fSource: $("#fs").text,
    errorLines: [],
    show: true,
    soundCloudClientId: '3f4914e324f9caeb23c521f0f1835a60',
  };
  g.errorLineNumberOffset = -g.vsHeader.split("\n").length;

  sc.initialize({
    client_id: g.soundCloudClientId,
  });

  g.streamSource = audioStreamSource.create({
    context: context,
    loop: true,
    autoPlay: true,
    crossOrigin: "anonymous",
  });
  g.streamSource.on('error', function(e) {
    console.error(e);
    setPlayState();
    setSoundSuccessState(false, e.toString());
  });
  g.streamSource.on('newSource', function(source) {
    source.connect(analyser);
    setPlayState();
    setSoundSuccessState(true);
  });

  playElem.addEventListener('click', function() {
    if (g.streamSource.isPlaying()) {
      g.streamSource.stop();
    } else {
      g.streamSource.play();
    }
    setPlayState();
  });

  function setPlayState() {
    playNode.nodeValue = g.streamSource.isPlaying() ? _pauseIcon : _playIcon;
  }

  function setSoundUrl(url) {
    if (!url) {
      g.streamSource.stop();
      setPlayState();
      return;
    }
    sc.get("/resolve", { url: url })
    .then(function(result) {
      if (result.streamable && result.stream_url) {
        var src = result.stream_url + '?client_id=' + g.soundCloudClientId;
        g.streamSource.setSource(src);
      } else {
        console.error("not streamable:", url);
        setSoundSuccessState(false, "not streamable according to soundcloud");
      }
    })
    .catch(function(e) {
      console.error("bad url:", url, e);
      setSoundSuccessState(false, "not a valid soundcloud url?");
    });
  }

  soundElem.addEventListener('change', function(e) {
    var url = e.target.value.trim();
    if (url != settings.sound) {
      settings.sound = url;
      setSoundUrl(url);
    }
  });

  var validModes = {
    "LINES": gl.LINES,
    "LINE_STRIP": gl.LINE_STRIP,
    "LINE_LOOP": gl.LINE_LOOP,
    "POINTS": gl.POINTS,
  };

  var validLineSizes = {
    "NATIVE": true,
    "CSS": true,
  }

  var saveElem = $("#save");
  saveElem.addEventListener('click', function() {
    console.log("save");
  });

  function setSoundSuccessState(success, msg) {
    soundElem.style.borderColor = success ? "" : "red";
    if (!success && msg) {
      addNotification(msg);
    }
  }

  setShaderSuccessStatus(false);

  function ProgramManager(gl) {
    var _handlers = {};
    var _programInfo;
    var _queue = [];
    var _timeout = 500;
    var _vs;
    var _fs;
    var _prg;
    var _src;

    function _emit(event) {
      var handler = _handlers[event];
      if (handler) {
        handler.apply(null, Array.prototype.slice.call(arguments, 1));
      }
    }

    function _compileShader(type, src) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    }

    function _linkProgram(vs, fs) {
      var prg = gl.createProgram();
      gl.attachShader(prg, vs);
      gl.attachShader(prg, fs);
      gl.linkProgram(prg);
      return prg;
    }

    function _getShaderResults(shader) {
      var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
      if (!success) {
        var errors = gl.getShaderInfoLog(shader);
        console.error(errors);
        return errors;
      }
    }

    function _getProgramResults(prg) {
      var success = gl.getProgramParameter(prg, gl.LINK_STATUS);
      if (!success) {
        var errors =  gl.getProgramInfoLog(prg);
        console.error(errors);
        return errors;
      }
    }

    function _checkResults() {
      var vsErrors = _getShaderResults(_vs);
      var fsErrors = _getShaderResults(_fs);
      var prgErrors = _getProgramResults(_prg);

      // We don't need the shaders. If successful
      // they are linked in the program. In failure
      // we'll make new ones anyway.
      gl.deleteShader(_fs);
      gl.deleteShader(_vs);

      if (vsErrors === undefined &&
          fsErrors === undefined &&
          prgErrors === undefined) {
        // success!
        _emit('success', _src);
        if (_programInfo) {
          gl.deleteProgram(_programInfo.program);
        }
        _programInfo = twgl.createProgramInfoFromProgram(gl, _prg);
      } else {
        // failure
        _emit('failure', [
          vsErrors || '',
          fsErrors || '',
          prgErrors || '',
        ].join("\n"));
        gl.deleteProgram(_prg);
      }
      _processQueue();
    }

    function _processQueue() {
      if (!_queue.length) {
        return;
      }
      _src = _queue.shift();
      _vs = _compileShader(gl.VERTEX_SHADER, _src.vsrc);
      _fs = _compileShader(gl.FRAGMENT_SHADER, _src.fsrc);
      _prg = _linkProgram(_vs, _fs);
      // make sure the GPU driver executes this commands now.
      gl.flush();
      // check the results some time later.
      // this gives us a chance at async compilcation.
      setTimeout(_checkResults, _timeout);
    }

    this.on = function(event, handler) {
      _handlers[event] = handler;
    };

    // Haha! userData, just like C++. Grrr!
    this.compile = function(vsrc, fsrc, userData) {
      _queue = [{vsrc: vsrc, fsrc: fsrc, userData: userData}];
      _processQueue();
    };

    this.getProgramInfo = function() {
      return _programInfo;
    }
  };

  function setShaderSuccessStatus(success) {
    editorElem.style.borderColor = success ? "" : "red";
    saveElem.disabled = !success;
    g.shaderSuccess = success;
  }

  function clearLineErrors() {
    g.errorLines.forEach(function(lineHandle) {
      cm.doc.removeLineClass(lineHandle, "background", "errorLine");
    });
    g.errorLines = [];
  }

  var programManager = new ProgramManager(gl);
  programManager.on('success', function(e) {
    setShaderSuccessStatus(true);
    settings.shader = e.userData;
    clearLineErrors();
  });
  programManager.on('failure', function(errors) {
    setShaderSuccessStatus(false);

    clearLineErrors();

    var errorRE = /ERROR\:\s*0\:(\d+)/g;
    do {
      var m = errorRE.exec(errors);
      if (m) {
        var lineNum = parseInt(m[1]);
        if (!isNaN(lineNum) && lineNum > 0) {
          lineNum += g.errorLineNumberOffset;
          var lineHandle = cm.doc.getLineHandle(lineNum);
          if (lineHandle) {
            g.errorLines.push(lineHandle);
            cm.doc.addLineClass(lineHandle, "background", "errorLine");
          }
        }
      }
    } while (m);
  });

  function clamp(min, max, v) {
    return Math.min(max, Math.max(min, v));
  }

  var hideElem = $("#hide");
  var hideNode = document.createTextNode("hide");
  hideElem.appendChild(hideNode);
  hideElem.addEventListener('click', function() {
    g.show = !g.show;
    hideNode.nodeValue = g.show ? "hide" : "show";
    editorElem.style.display = g.show ? "block" : "none";
  });

  var colorElem = $("#background");
  colorElem.addEventListener('change', function(e) {
    settings.backgroundColor = cssParse.parseCSSColor(e.target.value, true);
  });

  var numElem = $("#num");
  var numRangeElem = $("#numRange");

  function handleNumEdit(e) {
    var num = clamp(1, g.maxCount, parseInt(e.target.value)) | 0;
    numRangeElem.value = num;
    settings.num = num;
  }
  numElem.addEventListener('change', handleNumEdit);
  numElem.addEventListener('input', handleNumEdit);

  numRangeElem.addEventListener('input', function(e) {
    var num = parseInt(e.target.value);
    numElem.value = num;
    settings.num = num;
  });

  var modeElem = $("#mode");
  modeElem.addEventListener('change', function(e) {
    settings.mode = e.target.value.toUpperCase();
    g.mode = validModes[settings.mode];
  });

  var sizeElem = $("#size");
  sizeElem.addEventListener('change', function(e) {
    settings.lineSize = e.target.value.toUpperCase();
  });

  var timeElem = $("#time");
  timeElem.addEventListener('click', function(e) {
    g.time = 0;
  });

  var helpElem = $("#help");
  var helpDialogElem = $("#helpDialog");
  helpElem.addEventListener('click', function(e) {
    helpDialogElem.style.display = "";
  });
  helpDialogElem.addEventListener('click', function(e) {
    helpDialogElem.style.display = "none";
  });

  window.addEventListener('mousemove', function(e) {
    g.mouse = [
      e.clientX / window.innerWidth  *  2 - 1,
      e.clientY / window.innerHeight * -2 + 1,
    ];
  });

  function isAllNumbers(array) {
    for (var ii = 0; ii < array.length; ++ii) {
      if (typeof array[ii] !== 'number') {
        return false;
      }
    }
    return true;
  }

  var cm = CodeMirror(editorElem, {
    value: "",
    theme: "blackboard",
    mode: "x-text/x-glsl",
    lineNumbers: true,
  });
  cm.refresh();

  var count = new Float32Array(g.maxCount);
  for (var ii = 0; ii < count.length; ++ii) {
    count[ii] = ii;
  }
  var arrays = {
    vertexId: { data: count, numComponents: 1 },
  };
  var bufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);

  function getMode(mode) {
    var m = modes[mode];
    return m === undefined ? gl.LINES : m;
  }

  var mainRE = /(void[\s\S]+main[\s\S]*\([\s\S]*\)[\s\S]*\{)/g;
  function tryNewProgram(text) {
    var vsrc = g.vsHeader + text;
    vsrc = vsrc.replace(mainRE, function(m) {
      return m + "gl_PointSize=1.0;";
    });
    var lastBraceNdx = vsrc.lastIndexOf("}");
    if (lastBraceNdx >= 0) {
      var before = vsrc.substr(0, lastBraceNdx);
      var after = vsrc.substr(lastBraceNdx);
      vsrc = before + ";gl_PointSize *= _dontUseDirectly_pointSize;" + after;
    }
    programManager.compile(vsrc, g.fSource, text);
  }

  var oldText;
  var oldTrimmedText;

  var lineCommentRE = /\/\/.*/g;
  var blockCommentRE = /\/\*[\s\S]*?\*\//g;
  var whiteSpaceRE = /[ \t][ \t]+/g
  var eolRE = /\n\n+/g
  function trimShaderText(text) {
    text = text.replace(lineCommentRE, '');
    text = text.replace(blockCommentRE, '');
    text = text.replace(whiteSpaceRE, ' ');
    text = text.replace(eolRE, "\n");
    return text;
  }

  function handleChange(cm) {
    var text = cm.doc.getValue();
    var trimmedText = trimShaderText(text);
    if (trimmedText !== oldTrimmedText) {
      oldText = text;
      oldTrimmedText = trimmedText;
      tryNewProgram(text);
    }
  }

  cm.on('change', handleChange);

  function validateSettings(settings) {
    settings.num = clamp(1, g.maxCount, (settings.num || 10000) | 0);
    if (validModes[settings.mode] === undefined) {
      settings.mode = "LINES";
    }
    if (validLineSizes[settings.lineSize] === undefined) {
      settings.lineSize = "NATIVE";
    }
    if (!settings.backgroundColor ||
        !Array.isArray(settings.backgroundColor) ||
        !settings.backgroundColor.length != 4 ||
        !isAllNumbers(settings.backgroundColor)) {
      settings.backgroundColor = [0, 0, 0, 1];
    }
  }

  function setUISettings(settings) {
    colorElem.value = colorUtils.makeCSSColorFromRgb01Array(settings.backgroundColor);
    numElem.value = settings.num;
    numRangeElem.value = settings.num;
    modeElem.value = settings.mode;
    sizeElem.value = settings.lineSize;
    soundElem.value = settings.sound;
  }

  function setSettings(settings) {
    validateSettings(settings);
    setUISettings(settings);

    g.mode = validModes[settings.mode];
    //shader// test bad

    setSoundUrl(settings.sound);
    cm.doc.setValue(settings.shader);
    tryNewProgram(settings.shader);
  }
  setSettings(settings);

  var uniforms = {
    time: 0,
    resolution: [1, 1],
    mouse: [0, 0],
    sound: soundTex,
    _dontUseDirectly_pointSize: 1,
  };

  function render(time) {
    time *= 0.001;
    var now = time;
    var elapsed = now - (g.then || 0);
    g.then = now;
    g.time += elapsed;

    twgl.resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    var size = settings.lineSize === "NATIVE" ? 1 : (window.devicePixelRatio || 1);
    gl.lineWidth(size);

    gl.clearColor.apply(gl, settings.backgroundColor);
    gl.clear(gl.COLOR_BUFFER_BIT);

    var programInfo = programManager.getProgramInfo();
    if (programInfo) {

      uniforms.time = g.time;
      uniforms.resolution[0] = gl.canvas.width;
      uniforms.resolution[1] = gl.canvas.height;
      uniforms.mouse[0] = g.mouse[0];
      uniforms.mouse[1] = g.mouse[1];
      uniforms._dontUseDirectly_pointSize = size;

      analyser.getByteFrequencyData(soundTexBuffer);
      twgl.setTextureFromArray(gl, soundTex, soundTexSpec.src, soundTexSpec);

      gl.useProgram(programInfo.program);
      twgl.setBuffersAndAttributes(gl, programInfo, bufferInfo);
      twgl.setUniforms(programInfo, uniforms);
      twgl.drawBufferInfo(gl, g.mode, bufferInfo, settings.num);
    }

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
});
// Copyright (c) 2011-2012, Motorola Mobility, Inc.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//  * Redistributions of source code must retain the above copyright
//    notice, this list of conditions and the following disclaimer.
//  * Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
//  * Neither the name of the Motorola Mobility, Inc. nor the names of its
//    contributors may be used to endorse or promote products derived from this
//    software without specific prior written permission.
//
//  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
// THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

var nodejs = (typeof window === 'undefined');
if(nodejs) {
  WebCL = require('../../webcl');
  clu = require('../../lib/clUtils');
  util = require('util');
  fs = require('fs');
  WebGL = require('node-webgl');
  document = WebGL.document();
  log = console.log;
  alert = console.log;
}

requestAnimationFrame = document.requestAnimationFrame;

var use_gpu = true;

var COMPUTE_KERNEL_FILENAME = "mandelbrot.cl";
var COMPUTE_KERNEL_NAME = "computeSet";
var WIDTH = 800;
var HEIGHT = 800;

// cl stuff
var cl = new WebCL();
var /* cl_context */        ComputeContext;
var /* cl_command_queue */  ComputeCommands;
var /* cl_program */        ComputeProgram;
var /* cl_device_id */      ComputeDeviceId;
var /* cl_device_type */    ComputeDeviceType;
var /* cl_mem */            ComputePBO;
var /* cl_kernel */         ckCompute;

var width = WIDTH;
var height = HEIGHT;
var Reshaped = false;
var Update = false;
var newWidth, newHeight; // only when reshape

// simulation
var nmax = 512;
var cX=0;//0.407476, // in (-2.5, 1)  @TODO add a list of predefined C choices
    cY=0;//0.234204; // in (-1, 1)
var scale = 200;//10000*300;

var oldMouseX, oldMouseY, mouseButtons=0;

// gl stuff
var gl;
var shaderProgram;
var pbo;
var TextureId = null;
var TextureWidth = WIDTH;
var TextureHeight = HEIGHT;
var VertexPosBuffer, TexCoordsBuffer;

function initialize(device_type) {
  log('Initializing');
  document.setTitle("OpenCL Mandelbrot set Demo");
  var canvas = document.createElement("fbo-canvas", width, height);

  // install UX callbacks
  document.addEventListener('resize', reshape);
  document.addEventListener('keydown', keydown);
  document.addEventListener("mousemove", motion);
  document.addEventListener("mousedown", function(evt) {
    mouse(evt, true);
  });
  document.addEventListener("mouseup", function(evt) {
    mouse(evt, false);
  });

  var err = init_gl(canvas);
  if (err != cl.SUCCESS)
    return err;

  err = init_cl(device_type);
  if (err != 0)
    return err;

  configure_shared_data(width, height);

  // Warmup call to assure OpenCL driver is awake
  resetKernelArgs(cX, cY, scale, nmax, width, height);
  
  executeKernel(width, height, ComputePBO);
  
  ComputeCommands.finish();

  return cl.SUCCESS;
}

// /////////////////////////////////////////////////////////////////////
// OpenGL stuff
// /////////////////////////////////////////////////////////////////////

function configure_shared_data(image_width, image_height) {
  log('configure shared data');
  
  // set up data parameter
  var num_texels = image_width * image_height;
  var num_values = num_texels * 4;
  var size_tex_data = 1 * num_values; // 1 is GL texture type UNSIGNED_BYTE size

  // create buffer object
  if (pbo) {
    gl.bindBuffer(gl.ARRAY_BUFFER, pbo);
    gl.deleteBuffer(pbo);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  pbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pbo);

  // buffer data
  gl.bufferData(gl.ARRAY_BUFFER, size_tex_data, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  // Create OpenCL representation of OpenGL PBO
  ComputePBO = ComputeContext.createFromGLBuffer(cl.MEM_WRITE_ONLY, pbo);
  if (!ComputePBO) {
    alert("Error: Failed to create CL PBO buffer");
    return -1;
  }
}

function init_textures(width, height) {
  log('  Init textures');

  if (TextureId)
    gl.deleteTexture(TextureId);
  TextureId = null;

  TextureWidth = width;
  TextureHeight = height;

  gl.activeTexture(gl.TEXTURE0);
  TextureId = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, TextureId);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TextureWidth, TextureHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function init_buffers() {
  log('  create buffers');
  var VertexPos = [ -1, -1, 
                    1, -1, 
                    1, 1, 
                    -1, 1 ];
  var TexCoords = [ 0, 0, 
                    1, 0, 
                    1, 1, 
                    0, 1 ];

  VertexPosBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, VertexPosBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(VertexPos), gl.STATIC_DRAW);
  VertexPosBuffer.itemSize = 2;
  VertexPosBuffer.numItems = 4;

  TexCoordsBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, TexCoordsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(TexCoords), gl.STATIC_DRAW);
  TexCoordsBuffer.itemSize = 2;
  TexCoordsBuffer.numItems = 4;
}

function compile_shader(gl, id) {
  var shaders = {
    "shader-vs" : [ 
        "attribute vec3 aCoords;",
        "attribute vec2 aTexCoords;", 
        "varying vec2 vTexCoords;",
        "void main(void) {", 
        "    gl_Position = vec4(aCoords, 1.0);",
        "    vTexCoords = aTexCoords;", 
        "}" ].join("\n"),
    "shader-fs" : [
         "#ifdef GL_ES",
         "  precision mediump float;",
         "#endif",
         "varying vec2 vTexCoords;",
         "uniform sampler2D uSampler;",
         "void main(void) {",
         "    gl_FragColor = texture2D(uSampler, vTexCoords.st);",
         "}" ].join("\n"),
  };

  var shader;
  if (nodejs) {
    if (!shaders.hasOwnProperty(id))
      return null;
    var str = shaders[id];

    if (id.match(/-fs/)) {
      shader = gl.createShader(gl.FRAGMENT_SHADER);
    } else if (id.match(/-vs/)) {
      shader = gl.createShader(gl.VERTEX_SHADER);
    } else {
      return null;
    }

  } else {
    var shaderScript = document.getElementById(id);
    if (!shaderScript) {
      return null;
    }

    var str = "";
    var k = shaderScript.firstChild;
    while (k) {
      if (k.nodeType == 3) {
        str += k.textContent;
      }
      k = k.nextSibling;
    }
    if (shaderScript.type == "x-shader/x-fragment") {
      shader = gl.createShader(gl.FRAGMENT_SHADER);
    } else if (shaderScript.type == "x-shader/x-vertex") {
      shader = gl.createShader(gl.VERTEX_SHADER);
    } else {
      return null;
    }
  }

  gl.shaderSource(shader, str);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    alert(gl.getShaderInfoLog(shader));
    return null;
  }

  return shader;
}

function init_shaders() {
  log('  Init shaders');
  var fragmentShader = compile_shader(gl, "shader-fs");
  var vertexShader = compile_shader(gl, "shader-vs");

  shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    alert("Could not initialise shaders");
  }

  gl.useProgram(shaderProgram);

  shaderProgram.vertexPositionAttribute = gl.getAttribLocation(shaderProgram, "aCoords");
  gl.enableVertexAttribArray(shaderProgram.vertexPositionAttribute);

  shaderProgram.textureCoordAttribute = gl.getAttribLocation(shaderProgram, "aTexCoords");
  gl.enableVertexAttribArray(shaderProgram.textureCoordAttribute);
  
  shaderProgram.samplerUniform = gl.getUniformLocation(shaderProgram, "uSampler");
}

function init_gl(canvas) {
  log('Init GL');
  try {
    gl = canvas.getContext("experimental-webgl");
    gl.viewportWidth = canvas.width;
    gl.viewportHeight = canvas.height;
  } catch (e) {
  }
  if (!gl) {
    alert("Could not initialise WebGL, sorry :-(");
    return -1;
  }

  init_buffers();
  init_shaders();
  init_textures(width, height);

  return cl.SUCCESS;
}

function renderTexture() {
  // we just draw a screen-aligned texture
  gl.viewport(0, 0, width, height);

  gl.enable(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, TextureId);

  // draw screen aligned quad
  gl.bindBuffer(gl.ARRAY_BUFFER, VertexPosBuffer);
  gl.vertexAttribPointer(shaderProgram.vertexPositionAttribute,
      VertexPosBuffer.itemSize, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, TexCoordsBuffer);
  gl.vertexAttribPointer(shaderProgram.textureCoordAttribute,
      TexCoordsBuffer.itemSize, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(shaderProgram.samplerUniform, 0);

  gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.disable(gl.TEXTURE_2D);
}

// /////////////////////////////////////////////////////////////////////
// OpenCL stuff
// /////////////////////////////////////////////////////////////////////

function init_cl(device_type) {
  log('init CL');
  ComputeDeviceType = device_type ? cl.DEVICE_TYPE_GPU : cl.DEVICE_TYPE_CPU;

  // Pick platform
  var platformList = cl.getPlatforms();
  var platform = platformList[0];

  // create the OpenCL context
  ComputeContext = cl.createContext({
    deviceType: ComputeDeviceType, 
    shareGroup: gl, 
    platform: platform });

  var device_ids = ComputeContext.getInfo(cl.CONTEXT_DEVICES);
  if (!device_ids) {
    alert("Error: Failed to retrieve compute devices for context!");
    return -1;
  }

  var device_found = false;
  for(var i=0,l=device_ids.length;i<l;++i ) {
    device_type = device_ids[i].getInfo(cl.DEVICE_TYPE);
    if (device_type == ComputeDeviceType) {
      ComputeDeviceId = device_ids[i];
      device_found = true;
      break;
    }
  }

  if (!device_found) {
    alert("Error: Failed to locate compute device!");
    return -1;
  }

  // Create a command queue
  //
  ComputeCommands = ComputeContext.createCommandQueue(ComputeDeviceId, 0);
  if (!ComputeCommands) {
    alert("Error: Failed to create a command queue!");
    return -1;
  }

  // Report the device vendor and device name
  // 
  var vendor_name = ComputeDeviceId.getInfo(cl.DEVICE_VENDOR);
  var device_name = ComputeDeviceId.getInfo(cl.DEVICE_NAME);

  log("Connecting to " + vendor_name + " " + device_name);

  if (!ComputeDeviceId.getInfo(cl.DEVICE_IMAGE_SUPPORT)) {
    log("Application requires images: Images not supported on this device.");
    return cl.IMAGE_FORMAT_NOT_SUPPORTED;
  }

  err = init_cl_buffers();
  if (err != cl.SUCCESS) {
    log("Failed to create compute result! Error " + err);
    return err;
  }

  err = init_cl_kernels();
  if (err != cl.SUCCESS) {
    log("Failed to setup compute kernel! Error " + err);
    return err;
  }

  return cl.SUCCESS;
}

function init_cl_kernels() {
  log('  setup CL kernel');

  ComputeProgram = null;

  log("Loading kernel source from file '" + COMPUTE_KERNEL_FILENAME + "'...");
  source = fs.readFileSync(__dirname + '/' + COMPUTE_KERNEL_FILENAME, 'ascii');
  if (!source) {
    alert("Error: Failed to load kernel source!");
    return -1;
  }

  // Create the compute program from the source buffer
  //
  ComputeProgram = ComputeContext.createProgram(source);
  if (!ComputeProgram) {
    alert("Error: Failed to create compute program!");
    return -1;
  }

  // Build the program executable
  //
  try {
    ComputeProgram.build(ComputeDeviceId, "-cl-fast-relaxed-math");
  } catch (err) {
    log('Error building program: ' + err);
    alert("Error: Failed to build program executable!\n"
        + ComputeProgram.getBuildInfo(ComputeDeviceId, cl.PROGRAM_BUILD_LOG));
    return -1;
  }

  // Create the compute kernels from within the program
  //
  ckCompute = ComputeProgram.createKernel(COMPUTE_KERNEL_NAME);
  if (!ckCompute) {
    alert("Error: Failed to create compute row kernel!");
    return -1;
  }
  return cl.SUCCESS;
}

function resetKernelArgs(cx, cy, scale, nmax, image_width, image_height) {
  // set the kernel args
  try {
    // Set the Argument values for the row kernel
    ckCompute.setArg(1, cx, cl.type.FLOAT);
    ckCompute.setArg(2, cy, cl.type.FLOAT);
    ckCompute.setArg(3, scale, cl.type.FLOAT);
    ckCompute.setArg(4, nmax, cl.type.UINT);
    ckCompute.setArg(5, image_width, cl.type.UINT);
    ckCompute.setArg(6, image_height, cl.type.UINT);
  } catch (err) {
    alert("Failed to set row kernel args! " + err);
    return -10;
  }

  return cl.SUCCESS;
}

function init_cl_buffers() {
  log('  create CL buffers');

  return cl.SUCCESS;
}

function cleanup() {
  document.removeEventListener('resize', reshape);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('mousemove', motion);
  document.removeEventListener('mousedown', mouse);
  document.removeEventListener('mouseup', mouse);
  ComputeCommands.finish();
  ckCompute = null;
  ComputeProgram = null;
  ComputeCommands = null;
  ComputePBO = null;
  ComputeContext = null;
}

function shutdown() {
  log("Shutting down...");
  cleanup();
  process.exit(0);
}

// /////////////////////////////////////////////////////////////////////
// rendering loop
// /////////////////////////////////////////////////////////////////////

function display(timestamp) {
  //FrameCount++;
  //var uiStartTime = new Date().getTime();

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (Reshaped) {
    Reshaped = false;
    width = newWidth;
    height = newHeight;
    cleanup();
    if (initialize(ComputeDeviceType == cl.DEVICE_TYPE_GPU) != cl.SUCCESS)
      shutdown();
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  var err = execute_kernel();
  if (err != 0) {
    alert("Error " + err + " from execute_kernel!");
    process.exit(1);
  }

  renderTexture();
  //reportInfo();

  gl.finish(); // for timing

  //var uiEndTime = new Date().getTime();
  //ReportStats(uiStartTime, uiEndTime);
  //DrawText(TextOffset[0], TextOffset[1], 1, (Animated == 0) ? "Press space to animate" : " ");
  return cl.SUCCESS;
}

function reshape(evt) {
  newWidth = evt.width;
  newHeight = evt.height;
  Reshaped = true;
}

function keydown(evt) {
  log('process key: ' + evt.which);
  switch(evt.which) {
    case 286:
      cX += 1/scale;
      break;
    case 285:
      cX -= 1/scale;
      break;
    case 283:
      cY += 1/scale;
      break;
    case 284:
      cY -= 1/scale;
      break;
  }
  Update=true;
}

function mouse(evt, isDown) {
  //log('buttons: '+evt.button)
  if (isDown)
    mouseButtons |= 1 << evt.button;
  else
    mouseButtons = 0;

  oldMouseX=evt.x;
  oldMouseX=evt.y;
}

function motion(evt) {
  var dx = (evt.x - oldMouseX);
  var dy = (evt.y - oldMouseY);

  //log('dx='+dx+' dy='+dy)
  var refresh=false;
  var slowFactor=0.1;
  var moveSpeed = 0.1;
  var zoomSpeed = 1;

  if (mouseButtons & 1) {
    cX-=slowFactor*moveSpeed*(dx>=0 ? 1 : -1)*Math.log(1+scale/width);
    cY+=slowFactor*moveSpeed*(dy>=0 ? 1 : -1)*Math.log(1+scale/height);
    Update=true;
  }

  else if (mouseButtons & 2) {
    if(dy<0) scale *= (1 + slowFactor * zoomSpeed);
    else scale /= (1 + slowFactor * zoomSpeed);

    Update=true;
  }

  oldMouseX = evt.x;
  oldMouseY = evt.y;
}

function execute_kernel() {
  //log('execute_kernel...');

  if (Update) {
    Update = false;

    resetKernelArgs(cX, cY, scale, nmax, width, height);
  }

  // Sync GL and acquire buffer from GL
  gl.finish();
  ComputeCommands.enqueueAcquireGLObjects(ComputePBO);

  executeKernel(width, height, ComputePBO);

  // Release buffer
  ComputeCommands.enqueueReleaseGLObjects(ComputePBO);
  ComputeCommands.finish();
  
  // Update the texture from the pbo
  gl.bindTexture(gl.TEXTURE_2D, TextureId);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA,
      gl.UNSIGNED_BYTE, null);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return cl.SUCCESS;
}

function executeKernel(image_width, image_height, cmOutputBuffer) {
  // Setup Kernel Args
  ckCompute.setArg(0, cmOutputBuffer);

  // Set global and local work sizes for row kernel
  var global = [ image_width, image_height ];

  try {
    ComputeCommands.enqueueNDRangeKernel(ckCompute, null, global, null);
  } catch (err) {
    alert("Failed to enqueue row kernel! " + err);
    return err;
  }
}

function main() {
  // init window
  if(initialize(use_gpu)==cl.SUCCESS) {
    function update() {
      display();
      requestAnimationFrame(update);
    }
    update();
  }
}

main();


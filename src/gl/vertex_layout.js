import gl from './constants'; // web workers don't have access to GL context, so import all GL constants
import VertexData from './vertex_data';
import hashString from '../utils/hash';

// Describes a vertex layout that can be used with many different GL programs.
export default class VertexLayout {
    // Attribs are an array, in layout order, of: name, size, type, normalized
    // ex: { name: 'position', size: 3, type: gl.FLOAT, normalized: false }
    constructor (attribs) {
        this.attribs = attribs; // array of attributes, specified as standard GL attrib options
        this.components = [];   // list of type and offset info about each attribute component
        this.index = {};        // linear buffer index of each attribute component, e.g. this.index.position.x

        // Calc vertex stride
        this.stride = 0;

        var index = 0, count = 0;
        for (let a=0; a < this.attribs.length; a++) {
            let attrib = this.attribs[a];
            attrib.offset = this.stride;
            attrib.byte_size = attrib.size;
            var shift = 0;

            switch (attrib.type) {
                case gl.FLOAT:
                case gl.INT:
                case gl.UNSIGNED_INT:
                    attrib.byte_size *= 4;
                    shift = 2;
                    break;
                case gl.SHORT:
                case gl.UNSIGNED_SHORT:
                    attrib.byte_size *= 2;
                    shift = 1;
                    break;
            }

            // Force 4-byte alignment on attributes
            this.stride += attrib.byte_size;
            if (this.stride & 3) { // pad to multiple of 4 bytes
                this.stride += 4 - (this.stride & 3);
            }

            // Add info to list of attribute components
            // Used to build the vertex data, provides pointers and offsets into each typed array view
            // Each component is an array of:
            // [GL attrib type, pointer to typed array view, bits to shift right to determine buffer offset, additional buffer offset for the component]
            var offset_typed = attrib.offset >> shift;
            if (attrib.size > 1) {
                for (let s=0; s < attrib.size; s++) {
                    this.components.push([attrib.type, null, shift, offset_typed++, count++]);
                }
            }
            else {
                this.components.push([attrib.type, null, shift, offset_typed, count++]);
            }

            // Provide an index into the vertex data buffer for each attribute component
            this.index[attrib.name] = index;
            index += attrib.size;
        }
    }

    // Setup a vertex layout for a specific GL program
    // Assumes that the desired vertex buffer (VBO) is already bound
    // If a given program doesn't include all attributes, it can still use the vertex layout
    // to read those attribs that it does recognize, using the attrib offsets to skip others.
    enable (gl, program, force)
    {
        var attrib, location;

        // Enable all attributes for this layout
        for (var a=0; a < this.attribs.length; a++) {
            attrib = this.attribs[a];
            location = program.attribute(attrib.name).location;

            if (location !== -1) {
                if (!VertexLayout.enabled_attribs[location] || force) {
                    gl.enableVertexAttribArray(location);
                }
                gl.vertexAttribPointer(location, attrib.size, attrib.type, attrib.normalized, this.stride, attrib.offset);
                VertexLayout.enabled_attribs[location] = program;
            }
        }

        // Disable any previously bound attributes that aren't for this layout
        for (location in VertexLayout.enabled_attribs) {
            this.disableUnusedAttribute(gl, location, program);
        }
    }

    // Disable an attribute if it was not enabled for the specified program
    // NOTE: this was moved out of the inner loop in enable() to assist w/VM optimization
    disableUnusedAttribute (gl, location, program) {
        if (VertexLayout.enabled_attribs[location] !== program) {
            gl.disableVertexAttribArray(location);
            delete VertexLayout.enabled_attribs[location];
        }
    }

    createVertexData () {
        return new VertexData(this);
    }

    // Lazily create the add vertex function
    getAddVertexFunction () {
        if (this.addVertex == null) {
            this.createAddVertexFunction();
        }
        return this.addVertex;
    }

    // Dynamically compile a function to add a plain JS vertex array to this layout's typed VBO arrays
    createAddVertexFunction () {
        let key = hashString(JSON.stringify(this.attribs));
        if (VertexLayout.add_vertex_funcs[key] == null) {
            let src = `
                vertex_data.checkBufferSize();
                var view, offset;`;

            let last_type, i=0;
            let components = [...this.components];
            components.sort((a, b) => (a[0] !== b[0]) ? (a[0] - b[0]) : (a[4] - b[4]));

            for (let c=0; c < components.length; c++) {
                let component = components[c];

                if (last_type !== component[0]) {
                    src += `
                        view = vertex_data.views[${component[0]}];
                        offset = vertex_data.offset${component[2] ? ' >> ' + component[2] : ''};
                    `;
                    last_type = component[0];
                }

                src += `view[offset + ${component[3]}] = vertex[${component[4]}];\n`;
            }

            src += `
                vertex_data.offset += vertex_data.vertex_layout.stride;
                vertex_data.vertex_count++;`;

            let func = new Function('vertex', 'vertex_data', src);
            VertexLayout.add_vertex_funcs[key] = func; //function vertexLayoutAddVertex(vertex, vertex_data) { func(vertex, vertex_data); };
        }

        this.addVertex = VertexLayout.add_vertex_funcs[key];
    }

}

// Track currently enabled attribs, by the program they are bound to
// Static class property to reflect global GL state
VertexLayout.enabled_attribs = {};

// Functions to add plain JS vertex array to typed VBO arrays
VertexLayout.add_vertex_funcs = {}; // keyed by unique set of attributes

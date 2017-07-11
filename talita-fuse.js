const chokidar = require('chokidar'); //biblioteca que monitora o file system
const fs = require('fs'); //ler arquivos do file system
const metadata = require('musicmetadata'); //ler atributos de mp3 (autor, ano, album)
const fuse = require('fuse-bindings');

const params = {
    srcDir: `/home/talita/real`, //diretorio fisico (real)
    mntDir: `/home/talita/virtual`, //diretorio virtual
    dirYear: `Por_Ano`,
    dirAlbum: `Por_Album`,
    dirArtist: `Por_Artista`
};

const mp3Array = Array();

const main = function(){
    console.log(`Scanning ${params.srcDir}`);
    //monitorar o file system
    var monitor = chokidar.watch(params.srcDir, { persistent: false });

    monitor.on(`add`, monitorNewFile); //qnd adicionado um novo arquivo
    monitor.on(`unlink`, monitorFileRemoved); //qnd removido um arquivo
    monitor.on(`ready`, onFileSystemReady);
    monitor.on(`error`, function(err){
        console.log(`Monitor error: ${err}`);
    });
};

//chamada quando um novo arquivo é encontrado ou adicionado
const monitorNewFile = function(filePath, stats){
    console.log(`New file added ${filePath}`);
    //espera 200 ms para comecar a ler o arquivo para dar tempo do SO fechar o descritor
    setTimeout(function(){
        //abre um arquivo para leitura
        var readableStream = fs.createReadStream(filePath);
        //le o arquivo mp3 e extrai os metadados
        var parser = metadata(readableStream, function (err, metadata) {
            if (err){
                throw err;
            }
            readableStream.close();
            metadata.path = filePath; //add o path fisico do arquivo
            metadata.stats = stats; //add os stats originais (file size, user ID, etc)
            
            metadata.yearName = `${metadata.artist} -- ${metadata.album} -- ${metadata.track.no} -- ${metadata.title}.mp3`;
            metadata.albumName = `${metadata.track.no} -- ${metadata.title}.mp3`;
            metadata.artistName = `${metadata.album} -- ${metadata.track.no} -- ${metadata.title}.mp3`;
            
            delete metadata.picture; //deleta imagem caso tenha (ocupa mt espaco)
            //console.log(JSON.stringify(metadata, null, 4));
            mp3Array.push(metadata); //adiciona nova mp3
    })}, 200);
};

const monitorFileRemoved = function(filePath){
    console.log(`File removed ${filePath}`);
    for(var i = 0;i < mp3Array.length;i++) {
        var mp3 = mp3Array[i];
        if(mp3.path == filePath) {
            mp3Array.splice(i, 1);
        }
    }
};

const onFileSystemReady = function(){
    console.log(`Mounting fuse file system on ${params.mntDir}`);

    //montando file system fuse
    fuse.mount(params.mntDir, {
        readdir: fuseReadDir,
        getattr: fuseReadStats,
        open: fuseOpen,
        read: fuseReadFile
    });

    //recebe chamada do SO para fechar o programa, desmontando fuse
    process.on('SIGINT', function () {
        fuse.unmount(params.mntDir, function (err) {
            if (err) {
                console.log(`Error while unmonting fuse at ${params.mntDir}. Are you inside the file system?`);
            } else {
                console.log('Done!');
            }
        });
    });
};

const fuseReadDir = function(path, cb){
    var entries = [`.`, `..`];
    var paths = path.split(`/`);

    //se o SO pediu a raiz do diretorio fuse, entrega os diretorios virtuais
    if(path == `/`){
        entries.push(params.dirYear);
        entries.push(params.dirAlbum);
        entries.push(params.dirArtist);
        return cb(0, entries);
    } else if(paths.length == 2) {
        if(paths[1] == params.dirYear) {
            entries = entries.concat(getAllYears());
        } else if(paths[1] == params.dirAlbum){
            entries = entries.concat(getAllAlbums());
        } else if(paths[1] == params.dirArtist) {
            entries = entries.concat(getAllArtists());
        }
        return cb(0, entries);
    } else if(paths.length == 3) {
        if(paths[1] == params.dirYear) {
            entries = entries.concat(getAllMP3ByYear(paths[2]));
        } else if(paths[1] == params.dirAlbum) {
            entries = entries.concat(getAllMP3ByAlbum(paths[2]));
        } else if(paths[1] == params.dirArtist) {
            entries = entries.concat(getAllMP3ByArtist(paths[2]));
        }
        return cb(0, entries);
    }
    //fecha readDir
    cb(0);
};

const fuseReadStats = function(path, cb){
    if(path.endsWith(`.mp3`)){
        var paths = path.split(`/`);
        var mp3 = getMP3ByVirtualPaths(paths);
        //entrega stats somente leitura (arquivo)
        cb(0, {
            mtime: mp3.stats.mtime,
            atime: mp3.stats.atime,
            ctime: mp3.stats.ctime,
            size: mp3.stats.size,
            mode: 33060, // decimal para octal, fica readOnly (r--r--r--)
            uid: mp3.stats.uid,
            gid: mp3.stats.gid
        });
        return;   
    }else if (path == `/` 
            || path.startsWith(`/${params.dirYear}`)
            || path.startsWith(`/${params.dirAlbum}`)
            || path.startsWith(`/${params.dirArtist}`)){
        //entrega stats somente leitura (diretorio)
        cb(0, {
            mtime: new Date(), // datas fajutas, pois os diretórios são virtuais
            atime: new Date(),
            ctime: new Date(),
            size: 100, // tamanho fake de um diretório vazio, pois é virtual
            mode: 16749, // decimal para octal, fica readOnly com listagem (r-xr-xr-x)
            uid: process.getuid ? process.getuid() : 0, // Pega o user e o grupo corrente, pois é virtual
            gid: process.getgid ? process.getgid() : 0
        });
        return;
    }

    //fecha readStats
    cb(fuse.ENOENT);
};

//chamada quando o SO pede um numero de descritor para ler um arquivo
const fuseOpen = function (path, flags, cb) {
    cb(0, 42); // entrega fixo um numero de descritor qq
};

const fuseReadFile = function (path, fd, buffer, length, position, cb) {
    var paths = path.split(`/`);
    
    if(paths.length != 4) {
        return cb(0);
    }

    var mp3 = getMP3ByVirtualPaths(paths);
    
    fs.readFile(mp3.path, function(err, data) {
        if (position >= data.length) {
            console.log(`Done reading file.`);
            return cb(0); // Fim do arquivo
        }
        var part = data.slice(position, position + length);
        part.copy(buffer); // Copia o pedaço requisitado pelo SO para o buffer
        return cb(part.length); // Retorna a quantidade de bytes escritos no buffer
    });
};

const getAllYears = function() {
    var years = Array();
    for(var i = 0;i < mp3Array.length; i++) {
        years.push(mp3Array[i].year);
    }
    
    return filterUnique(years);
}

const getAllArtists = function() {
    var artists = Array();
    for(var i = 0;i < mp3Array.length; i++) {
        artists.push(mp3Array[i].artist);
    }
    
    return filterUnique(artists);
}

const getAllAlbums = function() {
    var album = Array();
    for(var i = 0;i < mp3Array.length; i++) {
        album.push(mp3Array[i].album);
    }
    
    return filterUnique(album);
}

const getAllMP3ByAlbum = function(album) {
    var mp3 = Array();

    for(var i = 0;i < mp3Array.length; i++) {
        var file = mp3Array[i];
        if(file.album == album) {
            mp3.push(file.albumName);
        }
    }

    return filterUnique(mp3);
}

const getAllMP3ByYear = function(year) {
    var mp3 = Array();

    for(var i = 0;i < mp3Array.length; i++) {
        var file = mp3Array[i];
        if(file.year == year) {
            mp3.push(file.yearName);
        }
    }

    return filterUnique(mp3);
}

const getAllMP3ByArtist = function(artist) {
    var mp3 = Array();

    for(var i = 0;i < mp3Array.length; i++) {
        var file = mp3Array[i];
        if(file.artist == artist) {
            mp3.push(file.artistName);
        }
    }

    return filterUnique(mp3);
}

//filtra um array com duplicatas e retorna um array ordenado com entradas unicas
const filterUnique = function(arr) {
    var i;
    var len = arr.length;
    var out = Array();
    var obj = {};
    
    for (i = 0; i < len; i++) {
        obj[arr[i]] = 0;
    }
    
    for (i in obj) {
        out.push(i);
    }
    
    return out.sort();
}

const getMP3ByVirtualPaths = function(paths) {
    if(paths[1] == params.dirYear) {
        return getMP3ByYearName(paths[3]);
    } else if(paths[1] == params.dirAlbum) {
        return getMP3ByAlbumName(paths[3]);
    } else if(paths[1] == params.dirArtist) {
        return getMP3ByArtistName(paths[3]);
    }
}

const getMP3ByYearName = function(mp3FileName) {
    for(var i = 0;i < mp3Array.length;i++) {
        var mp3 = mp3Array[i];
        if(mp3.yearName == mp3FileName) {
            return mp3;
        }
    }
    throw `Error MP3 ${mp3FileName} not found!`;
}

const getMP3ByAlbumName = function(mp3FileName) {
    for(var i = 0;i < mp3Array.length;i++) {
        var mp3 = mp3Array[i];
        if(mp3.albumName == mp3FileName) {
            return mp3;
        }
    }
    throw `Error MP3 ${mp3FileName} not found!`;
}

const getMP3ByArtistName = function(mp3FileName) {
    for(var i = 0;i < mp3Array.length;i++) {
        var mp3 = mp3Array[i];
        if(mp3.artistName == mp3FileName) {
            return mp3;
        }
    }
    throw `Error MP3 ${mp3FileName} not found!`;
}

main();
